import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer } from '../src/server/app.ts';
import { readConfig } from '../src/server/config.ts';
import { createFakeCloud } from '../src/server/cloud/fake.ts';
import { simulatedWav } from '../src/server/cloud/audio.ts';
import type { ToolExchange } from '../src/server/cloud/types.ts';
import { client } from './helpers/socket.ts';

test('无工具闲聊的最终生成仍以用户原问题作为最后一条消息', async () => {
  const cloud = createFakeCloud(); cloud.transcribe = async () => '阿森纳是什么球队';
  cloud.decideTools = async () => ({ calls: [] });
  cloud.streamFinal = async function* (messages) {
    assert.deepEqual(messages.at(-1), { role: 'user', content: '阿森纳是什么球队' });
    const system = messages.find(message => message.role === 'system')!.content;
    assert.match(system, /当前唯一注册工具：get_server_time/); assert.match(system, /每次回复 1-3 句/);
    assert.match(system, /<act:nod\|shake\|tilt\|lean>/); assert.match(system, /永远不要输出/); assert.match(system, /没有 search_knowledge/);
    yield '<emo:happy>阿森纳是一支伦敦的足球队。';
  };
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', BRAIN_MODE: 'agent', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: ':memory:' }), cloud }); const connection = client(app.url);
  try {
    await connection.hello(); connection.send({ type: 'turn.submit', turnId: 'ordinary-final-intent', audio: { format: 'wav', data: simulatedWav().toString('base64') } });
    const event = await connection.wait(e => (e.type === 'turn.done' || e.type === 'turn.error') && e.turnId === 'ordinary-final-intent');
    assert.equal(event.type, 'turn.done');
  } finally { connection.close(); await app.close(); }
});

test('明确询问当前时间但模型漏调用时有界纠正，真实调用仍由模型发起', async () => {
  const cloud = createFakeCloud(); let decisions = 0; let executed = 0;
  cloud.transcribe = async () => '现在北京时间几点？';
  cloud.decideTools = async () => ({ calls: ++decisions === 1 ? [] : [{ id: 'corrected-time-call', name: 'get_server_time', input: {} }] });
  cloud.streamFinal = async function* (_messages, exchanges) { assert.equal(exchanges[0].results[0].value.localTime, '2026-10-25 01:00:00'); yield '<emo:neutral>现在是北京时间一点。'; };
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', BRAIN_MODE: 'agent', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: ':memory:' }), cloud, timeProbe: async () => { executed++; return { iso: '2026-10-24T17:00:00Z', localTime: '2026-10-25 01:00:00' }; } }); const connection = client(app.url);
  try {
    await connection.hello(); connection.send({ type: 'turn.submit', turnId: 'correct-missed-time', audio: { format: 'wav', data: simulatedWav().toString('base64') } });
    const event = await connection.wait(e => (e.type === 'turn.done' || e.type === 'turn.error') && e.turnId === 'correct-missed-time');
    assert.equal(event.type, 'turn.done'); assert.equal(decisions, 2); assert.equal(executed, 1);
  } finally { connection.close(); await app.close(); }
});

test('同响应四次调用只执行三次，最终回答和口播不含工具过程文本', async () => {
  mkdirSync('.cache/tests', { recursive: true }); const directory = mkdtempSync('.cache/tests/agent-'); const database = join(directory, 'conversation.sqlite');
  const cloud = createFakeCloud(); let received: ToolExchange[] = []; const spoken: string[] = [];
  cloud.transcribe = async () => '请查询北京时间';
  cloud.decideTools = async () => ({ calls: Array.from({ length: 4 }, (_, index) => ({ id: 'call-' + index, name: 'get_server_time', input: { timeZone: 'Asia/Shanghai' } })), discardedTextChars: 4 });
  cloud.streamFinal = async function* (_messages, exchanges) { received = exchanges; yield '<emo:happy><act:nod>已根据服务器时间完成查询。'; };
  const synthesize = cloud.synthesize; cloud.synthesize = async (input, signal) => { spoken.push(input.text); return synthesize(input, signal); };
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', BRAIN_MODE: 'agent', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: database, AUDIT_PATH: join(directory, 'turns.jsonl') }), cloud });
  const connection = client(app.url);
  try {
    await connection.hello(); connection.send({ type: 'turn.submit', turnId: 'four-tool-calls-turn', audio: { format: 'wav', data: simulatedWav().toString('base64') } });
    const done = await connection.wait(e => e.type === 'turn.done' && e.turnId === 'four-tool-calls-turn');
    assert.equal(done.type === 'turn.done' && done.answer, '已根据服务器时间完成查询。');
    assert.equal(received[0].results.filter(result => !result.value.error).length, 3);
    assert.equal(received[0].results[3].value.error, 'quota_exhausted');
    const audit = spawnSync(process.execPath, ['--experimental-strip-types', 'src/cli/audit.ts', '--database', database, '--turn', 'four-tool-calls-turn'], { encoding: 'utf8', timeout: 5000 });
    const record = JSON.parse(audit.stdout).records[0];
    assert.equal(record.tools.filter((tool: { executed: boolean }) => tool.executed).length, 3);
    assert.equal(record.tools[3].status, 'rejected_quota');
    assert.equal(connection.events.some(e => e.type === 'turn.state' && e.turnId === 'four-tool-calls-turn' && e.state === 'querying'), true);
    assert.deepEqual(spoken.slice(1), ['已根据服务器时间完成查询。']);
  } finally { connection.close(); await app.close(); }
});

test('三次实际失败仍有收尾，非法工具和参数不执行且有限次判定后收尾', async () => {
  for (const invalid of [false, 'name', 'params'] as const) {
    const cloud = createFakeCloud(); let decisions = 0; let attempts = 0; let results: ToolExchange[] = [];
    cloud.decideTools = async () => { decisions++; return { calls: [{ id: 'call-' + decisions, name: invalid === 'name' ? 'unregistered_tool' : 'get_server_time', input: invalid === 'params' ? { timeZone: 'Europe/Paris' } : {} }] }; };
    cloud.streamFinal = async function* (_messages, exchanges) { results = exchanges; yield '<emo:sad>这次没有查到有效时间，稍后再试吧。'; };
    const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', BRAIN_MODE: 'agent', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: ':memory:' }), cloud, timeProbe: async () => { attempts++; throw new Error('external-clock-failure'); } });
    const connection = client(app.url);
    try {
      await connection.hello(); connection.send({ type: 'turn.submit', turnId: 'bounded-failed-' + String(invalid), audio: { format: 'wav', data: simulatedWav().toString('base64') } });
      const done = await connection.wait(e => e.type === 'turn.done' && e.turnId === 'bounded-failed-' + String(invalid));
      assert.equal(done.type === 'turn.done' && done.answer, '这次没有查到有效时间，稍后再试吧。');
      assert.equal(attempts, invalid ? 0 : 3); assert.equal(decisions, 3);
      assert.equal(results.flatMap(exchange => exchange.results).every(result => !!result.value.error), true);
    } finally { connection.close(); await app.close(); }
  }
});

test('工具等待中被接管会取消，迟到工具不进入最终生成或新页面', async () => {
  const cloud = createFakeCloud(); let finalCalls = 0; let release: (() => void) | undefined; let entered: (() => void) | undefined;
  const toolEntered = new Promise<void>(resolve => { entered = resolve; });
  cloud.decideTools = async () => ({ calls: [{ id: 'late-call', name: 'get_server_time', input: {} }] });
  cloud.streamFinal = async function* () { finalCalls++; yield '不应生成。'; };
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', BRAIN_MODE: 'agent', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: ':memory:' }), cloud, timeProbe: async () => { entered!(); await new Promise<void>(resolve => { release = resolve; }); return { localTime: '迟到结果' }; } });
  const old = client(app.url); let current: ReturnType<typeof client> | undefined;
  try {
    const ready = await old.hello(); old.send({ type: 'turn.submit', turnId: 'cancel-tool-wait', audio: { format: 'wav', data: simulatedWav().toString('base64') } });
    await toolEntered; current = client(app.url, ready.sessionId); await current.hello(); await old.wait(e => e.type === 'session.replaced');
    release!(); await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(finalCalls, 0); assert.equal(current.events.some(e => 'turnId' in e && e.turnId === 'cancel-tool-wait'), false);
  } finally { release?.(); old.close(); current?.close(); await app.close(); }
});
