import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase, StorageError } from '../server/store/database.ts';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function inspect(db: Database.Database) {
  const names = ['sessions', 'turns', 'messages', 'tool_attempts', 'knowledge_chunks', 'entities'];
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name));
  const counts = Object.fromEntries(names.filter(name => tables.has(name)).map(name => [name, (db.prepare(`SELECT count(*) AS count FROM ${name}`).get() as { count: number }).count]));
  const history = tables.has('messages') ? db.prepare('SELECT id,session_id,turn_id,role,content,created_at FROM messages ORDER BY id').all() : [];
  const columns = tables.has('messages') ? db.pragma('table_info(messages)') as { name: string }[] : [];
  return {
    schemaVersion: db.pragma('user_version', { simple: true }), counts,
    hasInterruptedFlag: columns.some(column => column.name === 'interrupted'),
    historyChecksum: createHash('sha256').update(JSON.stringify(history)).digest('hex'),
    integrity: (db.pragma('integrity_check', { simple: true })),
  };
}

async function main() {
  const command = process.argv[2];
  const database = argument('--database');
  if (!database || !['inspect', 'migrate', 'backup', 'restore'].includes(command)) throw new StorageError('用法：storage <inspect|migrate|backup|restore> --database <源文件> [--destination <新文件>]');
  const filename = resolve(database);
  if (command === 'migrate') {
    const db = openDatabase(filename);
    try { console.log(JSON.stringify(inspect(db))); } finally { db.close(); }
    return;
  }
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    if (command === 'inspect') { console.log(JSON.stringify(inspect(db))); return; }
    const destination = argument('--destination');
    if (!destination) throw new StorageError('备份或恢复需要 --destination 指定新的目标文件。');
    const output = resolve(destination);
    if (existsSync(output)) throw new StorageError('目标文件已存在，已拒绝覆盖；请选择新的目标文件。');
    const before = inspect(db);
    if (before.integrity !== 'ok') throw new StorageError('源数据库完整性检查失败，未创建备份或恢复文件。');
    mkdirSync(dirname(output), { recursive: true });
    await db.backup(output);
    const recovered = new Database(output, { readonly: true, fileMustExist: true });
    try {
      const after = inspect(recovered);
      if (after.integrity !== 'ok') throw new StorageError('备份或恢复文件完整性检查失败。');
      console.log(JSON.stringify({ operation: command, ...after }));
    } finally { recovered.close(); }
  } finally { db.close(); }
}

main().catch(error => {
  console.error(error instanceof StorageError ? error.message : '存储命令失败，请检查文件、目录权限和数据库版本。');
  process.exitCode = 1;
});
