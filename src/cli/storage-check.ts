import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { openDatabase, StorageError } from '../server/store/database.ts';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
  const directory = resolve(argument('--directory') ?? '.cache/storage-check');
  mkdirSync(directory, { recursive: true });
  const filename = join(directory, 'diagnostic.sqlite');
  let db = openDatabase(filename);
  db.exec('CREATE TABLE IF NOT EXISTS runtime_diagnostic (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT OR REPLACE INTO runtime_diagnostic(id,value) VALUES (?,?)').run('reopen', '已知持久记录');
  db.close();
  db = openDatabase(filename);
  try {
    const stored = db.prepare('SELECT value FROM runtime_diagnostic WHERE id = ?').get('reopen') as { value: string } | undefined;
    if (stored?.value !== '已知持久记录') throw new StorageError('重开后的数据校验失败。');
    let vector: Record<string, unknown>;
    try {
      const extensionPath = argument('--vector-extension');
      if (extensionPath) db.loadExtension(extensionPath); else sqliteVec.load(db);
      db.exec('DROP TABLE IF EXISTS diagnostic_vectors');
      db.exec('CREATE VIRTUAL TABLE diagnostic_vectors USING vec0(embedding float[1024])');
      const first = new Float32Array(1024); first[0] = 1;
      const second = new Float32Array(1024); second[1] = 1;
      const insert = db.prepare('INSERT INTO diagnostic_vectors(rowid,embedding) VALUES (?,?)');
      insert.run(1n, Buffer.from(first.buffer)); insert.run(2n, Buffer.from(second.buffer));
      const nearest = db.prepare('SELECT rowid,distance FROM diagnostic_vectors WHERE embedding MATCH ? AND k = 1 ORDER BY distance').get(Buffer.from(first.buffer)) as { rowid: number; distance: number };
      if (nearest?.rowid !== 1 || nearest.distance !== 0) throw new Error('近邻不符合已知样本');
      vector = { status: 'passed', dimensions: 1024, nearestRowId: nearest.rowid, distance: nearest.distance, version: db.prepare('SELECT vec_version() AS version').get() };
    } catch (error) {
      vector = { status: 'degraded', dimensions: 1024, reason: error instanceof Error ? error.message : '向量扩展加载或查询未通过', impact: '关系存储可继续支持 M0。' };
    }
    console.log(JSON.stringify({
      mode: 'real-native', runtime: { node: process.version, platform: process.platform, arch: process.arch, abi: process.versions.modules },
      relational: { persistedAcrossReopen: true, sqlite: db.prepare('SELECT sqlite_version() AS version').get() },
      schemaVersion: db.pragma('user_version', { simple: true }), vector,
    }));
  } finally { db.close(); }
}
try { main(); } catch (error) {
  console.error(error instanceof StorageError ? error.message : '原生存储诊断失败；请检查目录权限、运行时与依赖安装。');
  process.exitCode = 1;
}
