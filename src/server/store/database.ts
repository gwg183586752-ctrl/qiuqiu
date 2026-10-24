import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface Migration { version: number; sql: string }
export const migrations: Migration[] = [
  { version: 1, sql: `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
      greeting_scheduled INTEGER NOT NULL DEFAULT 0 CHECK(greeting_scheduled IN (0,1))
    );
    CREATE TABLE turns (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), connection_epoch INTEGER NOT NULL,
      input_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('processing','completed','failed','cancelled')),
      started_at TEXT NOT NULL, ended_at TEXT, question TEXT, answer TEXT, reason TEXT, timings_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
      turn_id TEXT NOT NULL REFERENCES turns(id), role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(turn_id,role)
    );
    CREATE TABLE tool_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT NOT NULL REFERENCES turns(id),
      ordinal INTEGER NOT NULL, name TEXT NOT NULL, executed INTEGER NOT NULL CHECK(executed IN (0,1)),
      status TEXT NOT NULL, input_json TEXT, result_json TEXT, duration_ms REAL NOT NULL,
      UNIQUE(turn_id,ordinal)
    );
    CREATE INDEX messages_session_order ON messages(session_id,id);
    CREATE INDEX turns_session_order ON turns(session_id,started_at);
  ` },
  { version: 2, sql: `
    ALTER TABLE messages ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0 CHECK(interrupted IN (0,1));
    CREATE TABLE knowledge_chunks (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, content TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE entities (
      id TEXT PRIMARY KEY, external_id TEXT, name TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}'
    );
  ` },
  { version: 3, sql: `ALTER TABLE sessions ADD COLUMN connection_epoch INTEGER NOT NULL DEFAULT 0;` },
  { version: 4, sql: `
    CREATE TABLE turn_events (id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT NOT NULL REFERENCES turns(id),phase TEXT NOT NULL,at TEXT NOT NULL,elapsed_ms REAL NOT NULL);
    CREATE INDEX turn_events_order ON turn_events(turn_id,id);
  ` },
];

export class StorageError extends Error {
  constructor(message: string) { super(message); this.name = 'StorageError'; }
}

export function openDatabase(filename: string, selectedMigrations: Migration[] = migrations): Database.Database {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new Database(filename);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const current = db.pragma('user_version', { simple: true }) as number;
    const latest = selectedMigrations.at(-1)?.version ?? 0;
    if (current > latest) throw new StorageError('数据库结构比当前程序更新，已拒绝启动；请使用匹配版本。');
    let previous = 0;
    for (const migration of selectedMigrations) {
      if (migration.version !== previous + 1) throw new StorageError('数据库迁移版本不连续，已拒绝启动。');
      previous = migration.version;
    }
    db.transaction(() => {
      for (const migration of selectedMigrations.filter(item => item.version > current)) {
        db.exec(migration.sql);
        db.pragma('user_version = ' + migration.version);
      }
    })();
    if (filename !== ':memory:') db.pragma('journal_mode = WAL');
    return db;
  } catch (error) {
    db.close();
    if (error instanceof StorageError) throw error;
    throw new StorageError('数据库初始化或迁移失败，原有事务已回滚；请保留数据库并检查版本。');
  }
}
