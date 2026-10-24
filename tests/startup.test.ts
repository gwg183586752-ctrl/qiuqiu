import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { startServer } from '../src/server/app.ts';
import { readConfig } from '../src/server/config.ts';

test('本机健康入口明确标识模拟模式且不泄露口令', async () => {
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'sentinel-private', PORT: '0', DATABASE_PATH: ':memory:' }) });
  try {
    const response = await fetch(app.url + '/health');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { status: 'ready', mode: 'fake', protocolVersion: 1 });
    assert.equal(JSON.stringify(body).includes('sentinel-private'), false);
    assert.equal(app.address, '127.0.0.1');
  } finally { await app.close(); }
});

test('真实模式缺少云密钥在启动前拒绝且只报告配置项名称', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', 'src/server/main.ts'], {
    encoding: 'utf8', env: { ...process.env, CLOUD_MODE: 'real', ACCESS_TOKEN: 'sentinel-private', MIMO_API_KEY: '' }, timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MIMO_API_KEY/);
  assert.equal(result.stderr.includes('sentinel-private'), false);
  assert.equal(result.stdout.includes('server.ready'), false);
});

test('健康服务关闭后释放端口，并可在没有后续里程碑凭证时启动真实模式', async () => {
  const first = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: ':memory:' }) });
  const port = new URL(first.url).port;
  await first.close();
  await first.close();
  const second = await startServer({ config: readConfig({ CLOUD_MODE: 'real', ACCESS_TOKEN: 'test', MIMO_API_KEY: 'unused-cloud-sentinel', PORT: port, DATABASE_PATH: ':memory:' }) });
  try {
    const response = await fetch(second.url + '/health');
    assert.equal((await response.json()).mode, 'real');
    assert.equal((await fetch(second.url + '/unknown')).status, 404);
  } finally { await second.close(); }
});

test('非法端口拒启且不回显配置值', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', 'src/server/main.ts'], {
    encoding: 'utf8', env: { ...process.env, CLOUD_MODE: 'fake', ACCESS_TOKEN: 'sentinel-private', PORT: 'private-invalid-port' }, timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PORT/);
  assert.equal(result.stderr.includes('private-invalid-port'), false);
});

test('模拟云诊断不需要密钥，并明确标记识别、回答和声音都是模拟结果', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', 'src/cli/cloud-check.ts', '--fake'], {
    encoding: 'utf8', env: { ...process.env, ACCESS_TOKEN: 'test', MIMO_API_KEY: '' }, timeout: 5000,
  });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'fake');
  assert.equal(report.evidence, 'simulated');
  assert.equal(report.transcript, '你好，小糖。');
  assert.ok(report.audioBytes > 44);
});
