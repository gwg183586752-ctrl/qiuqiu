import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { auditRecords, redactor } from '../server/audit.ts';

function argument(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
try {
  if (existsSync('.env')) loadEnvFile('.env');
  const turnId = argument('--turn'); const sessionId = argument('--session');
  if (!!turnId === !!sessionId || !/^[A-Za-z0-9_-]{1,80}$/.test(turnId ?? sessionId ?? '')) throw new Error('arguments');
  const db = new Database(argument('--database') ?? process.env.DATABASE_PATH ?? 'data/football.sqlite', { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout=5000');
    const records = auditRecords(db, { turnId, sessionId });
    const safe = redactor([process.env.MIMO_API_KEY ?? '', process.env.ACCESS_TOKEN ?? '']);
    console.log(safe(JSON.stringify({ status: records.length ? 'found' : 'empty', records }, null, 2)));
  } finally { db.close(); }
} catch {
  console.error('审计查询未完成。用法：npm run audit -- --turn <回合ID> 或 --session <会话ID>；可加 --database <已有数据库>。请检查参数、文件及程序版本。'); process.exitCode = 1;
}
