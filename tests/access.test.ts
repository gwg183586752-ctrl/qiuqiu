import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../src/server/app.ts';
import { readConfig } from '../src/server/config.ts';
import { createFakeCloud } from '../src/server/cloud/fake.ts';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { get } from 'node:http';

test('缺失或错误口令在升级前拒绝，正确口令才进入会话', async () => {
  const cloud = createFakeCloud(); let cloudCalls = 0;
  cloud.synthesize = async () => { cloudCalls++; throw new Error('must not run'); };
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'private-auth-sentinel', PORT: '0', DATABASE_PATH: ':memory:' }), cloud });
  try {
    for (const query of ['', '?token=wrong']) {
      const socket = new WebSocket(app.url.replace('http:', 'ws:') + '/ws' + query);
      const status = await new Promise<number>((resolve, reject) => {
        socket.on('unexpected-response', (_request, response) => { const status = response.statusCode!; response.resume(); socket.terminate(); resolve(status); });
        socket.on('open', () => { socket.terminate(); reject(new Error('unauthorized upgrade succeeded')); });
        socket.on('error', () => {});
      });
      assert.equal(status, 401);
    }
    assert.equal(cloudCalls, 0);
    const socket = new WebSocket(app.url.replace('http:', 'ws:') + '/ws?token=private-auth-sentinel');
    try { const event = await new Promise<any>((resolve, reject) => { socket.once('message', data => resolve(JSON.parse(data.toString()))); socket.once('error', reject); }); assert.equal(event.type, 'session.ready'); }
    finally { socket.terminate(); }
  } finally { await app.close(); }
});

test('跨站来源及伪造Host拒绝，鉴权失败没有会话或回合副作用', async () => {
  mkdirSync('.cache/tests', { recursive: true }); const directory = mkdtempSync('.cache/tests/access-'); const database = join(directory, 'conversation.sqlite');
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: database, AUDIT_PATH: join(directory, 'audit.jsonl') }) });
  try {
    const invalidHostStatus = await new Promise<number>((resolve, reject) => {
      const request = get(app.url + '/client-config', { headers: { Host: 'external.example' } }, response => { response.resume(); resolve(response.statusCode!); }); request.on('error', reject);
    });
    assert.equal(invalidHostStatus, 403);
    assert.equal((await fetch(app.url + '/client-config', { headers: { Origin: 'https://external.example' } })).status, 403);
    for (const [token, origin, expected] of [['wrong', app.url, 401], ['test', 'https://external.example', 403]]) {
      const socket = new WebSocket(app.url.replace('http:', 'ws:') + '/ws?token=' + token, { origin: String(origin) });
      const status = await new Promise<number>((resolve, reject) => {
        socket.on('unexpected-response', (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!); });
        socket.on('open', () => { socket.terminate(); reject(new Error('untrusted connection accepted')); }); socket.on('error', () => {});
      }); assert.equal(status, expected);
    }
    const inspect = spawnSync(process.execPath, ['--experimental-strip-types', 'src/cli/storage.ts', 'inspect', '--database', database], { encoding: 'utf8', timeout: 5000 });
    const result = JSON.parse(inspect.stdout); assert.equal(result.counts.sessions, 0); assert.equal(result.counts.turns, 0);
  } finally { await app.close(); }
});
