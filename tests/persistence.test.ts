import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../src/server/app.ts';
import { readConfig } from '../src/server/config.ts';
import { createFakeCloud } from '../src/server/cloud/fake.ts';
import { simulatedWav } from '../src/server/cloud/audio.ts';
import type { ChatMessage } from '../src/server/cloud/types.ts';
import { client } from './helpers/socket.ts';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';

const audio = () => ({ format: 'wav', data: simulatedWav().toString('base64') });

test('处理中相同回合只受理一次，但同标识不同录音明确拒绝', async () => {
  const cloud = createFakeCloud(); let calls = 0; let release: (() => void) | undefined;
  cloud.streamReply = async function* () { calls++; await new Promise<void>(resolve => { release = resolve; }); yield '原回合完成。'; };
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: ':memory:' }), cloud }); const connection = client(app.url);
  try {
    await connection.hello(); connection.send({ type: 'turn.submit', turnId: 'duplicate-active-turn', audio: audio() });
    await connection.wait(e => e.type === 'turn.state' && e.turnId === 'duplicate-active-turn' && e.state === 'thinking');
    connection.send({ type: 'turn.submit', turnId: 'duplicate-active-turn', audio: audio() });
    const changed = simulatedWav(); changed.writeInt16LE(1000, 44);
    connection.send({ type: 'turn.submit', turnId: 'duplicate-active-turn', audio: { format: 'wav', data: changed.toString('base64') } });
    const conflict = await connection.wait(e => e.type === 'turn.error' && e.turnId === 'duplicate-active-turn');
    assert.equal(conflict.type === 'turn.error' && conflict.code, 'turn_conflict');
    release!(); await connection.wait(e => e.type === 'turn.done' && e.turnId === 'duplicate-active-turn');
    assert.equal(calls, 1);
  } finally { release?.(); connection.close(); await app.close(); }
});

test('续聊窗口仅取最近十二条完整消息，已完成回合重提不追加或重播声音', async () => {
  mkdirSync('.cache/tests', { recursive: true }); const directory = mkdtempSync('.cache/tests/window-'); const database = join(directory, 'conversation.sqlite');
  const cloud = createFakeCloud(); let recognitions = 0; let received: ChatMessage[] = [];
  cloud.transcribe = async () => '问题' + (++recognitions);
  cloud.streamReply = async function* (messages) { received = messages; yield '回答' + recognitions + '。'; };
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: database, AUDIT_PATH: join(directory, 'turns.jsonl') }), cloud }); const connection = client(app.url);
  try {
    const ready = await connection.hello();
    for (let index = 1; index <= 9; index++) {
      const turnId = 'window-round-' + index; connection.send({ type: 'turn.submit', turnId, audio: audio() });
      await connection.wait(e => e.type === 'turn.done' && e.turnId === turnId); connection.send({ type: 'playback.done', turnId });
    }
    const history = received.slice(1, -1); assert.equal(history.length, 12);
    assert.deepEqual(history[0], { role: 'user', content: '问题3' }); assert.deepEqual(history.at(-1), { role: 'assistant', content: '回答8。' });
    const audioCount = connection.events.filter(e => e.type === 'speech.audio').length;
    connection.send({ type: 'turn.submit', turnId: 'window-round-9', audio: audio() });
    connection.send({ type: 'turn.submit', turnId: 'bad', audio: audio() });
    await connection.wait(e => e.type === 'turn.error' && e.code === 'invalid_turn');
    assert.equal(recognitions, 9); assert.equal(connection.events.filter(e => e.type === 'speech.audio').length, audioCount);
    const audit = spawnSync(process.execPath, ['--experimental-strip-types', 'src/cli/audit.ts', '--database', database, '--session', ready.sessionId], { encoding: 'utf8', timeout: 5000 });
    assert.equal(JSON.parse(audit.stdout).records.length, 9);
  } finally { connection.close(); await app.close(); }
});

test('启动恢复把遗留处理中回合记为中断，重提不会重新调用云', async () => {
  mkdirSync('.cache/tests', { recursive: true }); const directory = mkdtempSync('.cache/tests/interrupted-'); const database = join(directory, 'conversation.sqlite'); const snapshot = join(directory, 'snapshot.sqlite');
  const cloud = createFakeCloud(); let calls = 0; let release: (() => void) | undefined;
  cloud.streamReply = async function* () { calls++; await new Promise<void>(resolve => { release = resolve; }); yield '未完成的回复。'; };
  const config = readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: database, AUDIT_PATH: join(directory, 'turns.jsonl') });
  const first = await startServer({ config, cloud }); const old = client(first.url); let sessionId = '';
  try {
    sessionId = (await old.hello()).sessionId; old.send({ type: 'turn.submit', turnId: 'interrupted-processing', audio: audio() });
    await old.wait(e => e.type === 'turn.state' && e.turnId === 'interrupted-processing' && e.state === 'thinking');
    const backup = spawnSync(process.execPath, ['--experimental-strip-types', 'src/cli/storage.ts', 'backup', '--database', database, '--destination', snapshot], { encoding: 'utf8', timeout: 5000 });
    assert.equal(backup.status, 0, backup.stderr);
  } finally { old.close(); await first.close(); release?.(); }
  const second = await startServer({ config: { ...config, databasePath: snapshot }, cloud }); const current = client(second.url, sessionId);
  try {
    await current.hello(); current.send({ type: 'turn.submit', turnId: 'interrupted-processing', audio: audio() });
    const error = await current.wait(e => e.type === 'turn.error'); assert.equal(error.type === 'turn.error' && error.code, 'terminated_turn'); assert.equal(calls, 1);
    const audit = spawnSync(process.execPath, ['--experimental-strip-types', 'src/cli/audit.ts', '--database', snapshot, '--turn', 'interrupted-processing'], { encoding: 'utf8', timeout: 5000 });
    const record = JSON.parse(audit.stdout).records[0]; assert.equal(record.status, 'cancelled'); assert.equal(record.reason, 'process_interrupted');
  } finally { current.close(); await second.close(); }
});

test('问答第二条或终态写入失败均回滚，失败回合不进入后续上下文', async () => {
  mkdirSync('.cache/tests', { recursive: true }); const directory = mkdtempSync('.cache/tests/atomic-'); const database = join(directory, 'conversation.sqlite');
  const cloud = createFakeCloud(); const inputs: ChatMessage[][] = [];
  cloud.streamReply = async function* (messages) { inputs.push(messages); yield '应完整保存的回答。'; };
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: database, AUDIT_PATH: join(directory, 'turns.jsonl') }), cloud });
  const connection = client(app.url); const faults = new Database(database);
  try {
    await connection.hello();
    for (const [id, trigger] of [
      ['failed-second-message', "CREATE TRIGGER fail_write BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(FAIL,'injected'); END;"],
      ['failed-terminal-write', "CREATE TRIGGER fail_write BEFORE UPDATE ON turns WHEN NEW.status='completed' BEGIN SELECT RAISE(FAIL,'injected'); END;"],
    ]) {
      faults.exec(trigger); connection.send({ type: 'turn.submit', turnId: id, audio: audio() });
      await connection.wait(e => e.type === 'turn.error' && e.turnId === id);
      assert.equal(connection.events.some(e => e.type === 'turn.done' && e.turnId === id), false);
      faults.exec('DROP TRIGGER fail_write;');
      const audit = spawnSync(process.execPath, ['--experimental-strip-types', 'src/cli/audit.ts', '--database', database, '--turn', id], { encoding: 'utf8', timeout: 5000 });
      assert.equal(JSON.parse(audit.stdout).records[0].status, 'failed');
    }
    connection.send({ type: 'turn.submit', turnId: 'after-rollback-turn', audio: audio() });
    await connection.wait(e => e.type === 'turn.done' && e.turnId === 'after-rollback-turn');
    assert.deepEqual(inputs.map(messages => messages.slice(1, -1)), [[], [], []]);
  } finally { faults.close(); connection.close(); await app.close(); }
});

test('新连接接管并取消旧回合，旧生成迟到和关闭均不影响新连接', async () => {
  const cloud = createFakeCloud(); let release: (() => void) | undefined; let calls = 0; const receivedHistory: ChatMessage[][] = [];
  cloud.streamReply = async function* (messages) {
    receivedHistory.push(messages); calls++;
    if (calls === 1) { await new Promise<void>(resolve => { release = resolve; }); yield '旧回答不得保存。'; }
    else yield '新页面可以继续。';
  };
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: ':memory:' }), cloud });
  const old = client(app.url); let current: ReturnType<typeof client> | undefined;
  try {
    const first = await old.hello(); old.send({ type: 'turn.submit', turnId: 'old-inflight-turn', audio: audio() });
    await old.wait(e => e.type === 'turn.state' && e.turnId === 'old-inflight-turn' && e.state === 'thinking');
    current = client(app.url, first.sessionId); const second = await current.hello();
    const replaced = await old.wait(e => e.type === 'session.replaced'); assert.equal(replaced.connectionEpoch, first.connectionEpoch);
    assert.equal(second.connectionEpoch, first.connectionEpoch + 1);
    release!(); old.close();
    current.send({ type: 'turn.submit', turnId: 'new-current-turn', audio: audio() });
    await current.wait(e => e.type === 'turn.done' && e.turnId === 'new-current-turn');
    assert.deepEqual(receivedHistory[1].slice(1, -1), []);
    assert.equal(old.events.some(e => e.type === 'turn.done' && e.turnId === 'old-inflight-turn'), false);
    const third = client(app.url, first.sessionId);
    try { const ready = await third.hello(); assert.equal(ready.connectionEpoch, second.connectionEpoch + 1); await current.wait(e => e.type === 'session.replaced'); }
    finally { third.close(); }
  } finally { release?.(); old.close(); current?.close(); await app.close(); }
});
test('未播放完的完整问答在重启后续聊，未知身份重新分配且另一浏览器隔离', async () => {
  mkdirSync('.cache/tests', { recursive: true }); const directory = mkdtempSync('.cache/tests/persistence-');
  const config = readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: join(directory, 'conversation.sqlite') });
  const cloud = createFakeCloud(); let input: ChatMessage[] = [];
  cloud.transcribe = async () => '我喜欢阿森纳';
  cloud.streamReply = async function* (messages) { input = messages; yield '记住你喜欢阿森纳。'; };
  let app = await startServer({ config, cloud }); let connection = client(app.url, 'unknown-client-chosen');
  let sessionId = '';
  try {
    const ready = await connection.hello(); sessionId = ready.sessionId;
    assert.notEqual(sessionId, 'unknown-client-chosen');
    connection.send({ type: 'turn.submit', turnId: 'saved-unplayed-turn', audio: audio() });
    await connection.wait(e => e.type === 'turn.done' && e.turnId === 'saved-unplayed-turn');
  } finally { connection.close(); await app.close(); }
  app = await startServer({ config, cloud }); connection = client(app.url, sessionId);
  try {
    const ready = await connection.hello();
    assert.equal(ready.sessionId, sessionId); assert.equal(ready.type === 'session.ready' && ready.isNew, false);
    connection.send({ type: 'turn.submit', turnId: 'restored-followup', audio: audio() });
    await connection.wait(e => e.type === 'turn.done' && e.turnId === 'restored-followup');
    assert.deepEqual(input.slice(1, -1), [{ role: 'user', content: '我喜欢阿森纳' }, { role: 'assistant', content: '记住你喜欢阿森纳。' }]);
    assert.equal(connection.events.some(e => e.type === 'turn.done' && e.greeting), false);
    const other = client(app.url);
    try {
      await other.hello(); other.send({ type: 'turn.submit', turnId: 'other-browser-turn', audio: audio() });
      await other.wait(e => e.type === 'turn.done' && e.turnId === 'other-browser-turn');
      assert.deepEqual(input.slice(1, -1), []);
    } finally { other.close(); }
  } finally { connection.close(); await app.close(); }
});
