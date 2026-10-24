import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer } from '../src/server/app.ts';
import { readConfig } from '../src/server/config.ts';
import { createFakeCloud } from '../src/server/cloud/fake.ts';
import { simulatedWav } from '../src/server/cloud/audio.ts';
import { client } from './helpers/socket.ts';

test('公开审计命令可查询终态、独立播放指标和空结果，JSONL无凭证', async () => {
  mkdirSync('.cache/tests', { recursive: true }); const directory = mkdtempSync('.cache/tests/audit-');
  const database = join(directory, 'conversation.sqlite'); const auditPath = join(directory, 'turns.jsonl');
  const cloud = createFakeCloud(); cloud.transcribe = async () => '问句含 sentinel-cloud-key 与 ws://127.0.0.1:99/ws?token=sentinel-url-token&sessionId=private-session';
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: database, AUDIT_PATH: auditPath, MIMO_API_KEY: 'sentinel-cloud-key' }), cloud });
  const connection = client(app.url);
  const query = (id: string) => spawnSync(process.execPath, ['--experimental-strip-types', 'src/cli/audit.ts', '--database', database, '--turn', id], { encoding: 'utf8', env: { ...process.env, MIMO_API_KEY: 'sentinel-cloud-key', ACCESS_TOKEN: 'test' }, timeout: 5000 });
  try {
    await connection.hello(); connection.send({ type: 'turn.submit', turnId: 'audited-complete-turn', audio: { format: 'wav', data: simulatedWav().toString('base64') } });
    await connection.wait(e => e.type === 'turn.done' && e.turnId === 'audited-complete-turn');
    connection.send({ type: 'metric', turnId: 'audited-complete-turn', firstAudioMs: 3210 });
    connection.send({ type: 'playback.done', turnId: 'audited-complete-turn' });
    connection.send({ type: 'turn.submit', turnId: 'following-audit-turn', audio: { format: 'wav', data: simulatedWav().toString('base64') } });
    await connection.wait(e => e.type === 'turn.done' && e.turnId === 'following-audit-turn');
    const result = query('audited-complete-turn'); assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout); assert.equal(report.status, 'found'); assert.equal(report.records[0].status, 'completed');
    assert.equal(report.records[0].timings.firstAudioMs, 3210); assert.ok(report.records[0].timings.firstTextMs >= 0);
    assert.deepEqual(report.records[0].tools, []); assert.ok(report.records[0].stages.some((s: { phase: string }) => s.phase === 'recognizing'));
    assert.equal(result.stdout.includes('sentinel-cloud-key'), false);
    assert.equal(result.stdout.includes('sentinel-url-token'), false); assert.equal(result.stdout.includes('private-session'), false);
    const next = JSON.parse(query('following-audit-turn').stdout); assert.equal(next.records[0].timings.firstAudioMs, undefined);
    assert.equal(JSON.parse(query('does-not-exist').stdout).status, 'empty');
    assert.equal(readFileSync(auditPath, 'utf8').includes('sentinel-cloud-key'), false);
    assert.equal(readFileSync(auditPath, 'utf8').includes('sentinel-url-token'), false);
  } finally { connection.close(); await app.close(); }
});

test('JSONL无法追加只报告告警，SQLite成功问答仍可续聊且不重试云调用', async t => {
  mkdirSync('.cache/tests', { recursive: true }); const directory = mkdtempSync('.cache/tests/export-failure-');
  const database = join(directory, 'conversation.sqlite'); const warnings: string[] = [];
  t.mock.method(console, 'warn', (value: string) => warnings.push(value));
  const cloud = createFakeCloud(); let calls = 0; let historyLength = 0;
  cloud.streamReply = async function* (messages) { calls++; historyLength = messages.length - 2; yield '保存成功的回答。'; };
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: database, AUDIT_PATH: directory }), cloud });
  const connection = client(app.url);
  try {
    await connection.hello();
    for (const turnId of ['export-failure-one', 'export-failure-two']) {
      connection.send({ type: 'turn.submit', turnId, audio: { format: 'wav', data: simulatedWav().toString('base64') } });
      await connection.wait(e => e.type === 'turn.done' && e.turnId === turnId);
      connection.send({ type: 'playback.done', turnId });
    }
    assert.equal(calls, 2); assert.equal(historyLength, 2);
    assert.equal(warnings.filter(value => JSON.parse(value).event === 'audit.export_failed').length, 2);
    const audit = spawnSync(process.execPath, ['--experimental-strip-types', 'src/cli/audit.ts', '--database', database, '--turn', 'export-failure-one'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(JSON.parse(audit.stdout).records[0].status, 'completed');
  } finally { connection.close(); await app.close(); }
});
