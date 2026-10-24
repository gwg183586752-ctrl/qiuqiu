import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, relative } from 'node:path';

function removeTemporaryDirectory(directory: string) {
  const child = relative(tmpdir(), directory);
  if (child.startsWith('..') || !basename(directory).startsWith('qiuqiu-storage-')) throw new Error('临时目录越界');
  rmSync(directory, { recursive: true, force: true });
}

test('存储诊断证明重开后数据保留且真实1024维向量命中已知近邻', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qiuqiu-storage-'));
  try {
    const run = () => spawnSync(process.execPath, ['--experimental-strip-types', 'src/cli/storage-check.ts', '--directory', directory], { encoding: 'utf8', timeout: 15000 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.relational.persistedAcrossReopen, true);
      assert.equal(report.vector.status, 'passed');
      assert.equal(report.vector.dimensions, 1024);
      assert.equal(report.vector.nearestRowId, 1);
      assert.equal(report.schemaVersion, 4);
    }
  } finally { removeTemporaryDirectory(directory); }
});

test('只有向量扩展缺失时诊断明确降级而不否定关系存储', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qiuqiu-storage-'));
  try {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'src/cli/storage-check.ts', '--directory', directory, '--vector-extension', join(directory, 'missing.dll')], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.relational.persistedAcrossReopen, true);
    assert.equal(report.vector.status, 'degraded');
    assert.ok(report.vector.reason);
  } finally { removeTemporaryDirectory(directory); }
});

test('未知更新版本拒绝迁移且原数据库文件逐字节保留', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qiuqiu-storage-'));
  const filename = join(directory, 'diagnostic.sqlite');
  try {
    const db = new Database(filename);
    db.exec("CREATE TABLE valuable(value TEXT); INSERT INTO valuable VALUES ('已有数据'); PRAGMA user_version = 999;");
    db.close();
    const digest = () => createHash('sha256').update(readFileSync(filename)).digest('hex');
    const before = digest();
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'src/cli/storage-check.ts', '--directory', directory], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /结构比当前程序更新/);
    assert.equal(digest(), before);
  } finally { removeTemporaryDirectory(directory); }
});

test('迁移中途失败会回滚并保留原文件', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qiuqiu-storage-'));
  const filename = join(directory, 'diagnostic.sqlite');
  try {
    const db = new Database(filename);
    db.exec("CREATE TABLE turns(id TEXT); INSERT INTO turns VALUES ('既有回合'); PRAGMA user_version = 0;");
    db.close();
    const before = createHash('sha256').update(readFileSync(filename)).digest('hex');
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'src/cli/storage-check.ts', '--directory', directory], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /迁移失败/);
    assert.equal(createHash('sha256').update(readFileSync(filename)).digest('hex'), before);
  } finally { removeTemporaryDirectory(directory); }
});

test('前向迁移保留历史，一致性备份与恢复包含尚未checkpoint的WAL数据', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qiuqiu-storage-'));
  const filename = join(directory, 'legacy.sqlite');
  let live: Database.Database | undefined;
  const run = (command: string, database: string, destination?: string) => {
    const args = ['--experimental-strip-types', 'src/cli/storage.ts', command, '--database', database];
    if (destination) args.push('--destination', destination);
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    const db = new Database(filename);
    db.exec(`
      CREATE TABLE sessions(id TEXT PRIMARY KEY, created_at TEXT, greeting_scheduled INTEGER);
      CREATE TABLE turns(id TEXT PRIMARY KEY, session_id TEXT, connection_epoch INTEGER, input_hash TEXT, status TEXT, started_at TEXT, ended_at TEXT, question TEXT, answer TEXT, reason TEXT, timings_json TEXT);
      CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, turn_id TEXT, role TEXT, content TEXT, created_at TEXT);
      CREATE TABLE tool_attempts(id INTEGER PRIMARY KEY, turn_id TEXT, ordinal INTEGER, name TEXT, executed INTEGER, status TEXT, input_json TEXT, result_json TEXT, duration_ms REAL);
      INSERT INTO sessions VALUES ('known-session','2026-10-24',1);
      INSERT INTO turns(id,session_id,status) VALUES ('known-turn','known-session','completed');
      INSERT INTO messages VALUES (1,'known-session','known-turn','user','我喜欢阿森纳','2026-10-24');
      INSERT INTO messages VALUES (2,'known-session','known-turn','assistant','那我们聊聊枪手！','2026-10-24');
      PRAGMA user_version = 1;
    `);
    db.close();
    const original = run('inspect', filename);
    assert.equal(original.schemaVersion, 1);
    const migrated = run('migrate', filename);
    assert.equal(migrated.schemaVersion, 4);
    assert.equal(migrated.historyChecksum, original.historyChecksum);
    assert.equal(migrated.counts.messages, 2);
    assert.equal(migrated.counts.knowledge_chunks, 0);
    assert.equal(migrated.counts.entities, 0);
    assert.equal(migrated.hasInterruptedFlag, true);

    live = new Database(filename);
    live.pragma('journal_mode = WAL');
    live.prepare('UPDATE messages SET content = ? WHERE id = 2').run('WAL 中的完整回答');
    const current = run('inspect', filename);
    assert.notEqual(current.historyChecksum, original.historyChecksum);
    const backup = join(directory, 'snapshot.sqlite');
    run('backup', filename, backup);
    const restored = join(directory, 'restored.sqlite');
    run('restore', backup, restored);
    const recovered = run('inspect', restored);
    assert.equal(recovered.historyChecksum, current.historyChecksum);
    assert.equal(recovered.schemaVersion, 4);
  } finally { live?.close(); removeTemporaryDirectory(directory); }
});
