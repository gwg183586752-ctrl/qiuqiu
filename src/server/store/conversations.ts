import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openDatabase, StorageError } from './database.ts';
import type { ChatMessage } from '../cloud/types.ts';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { auditRecords, redactor } from '../audit.ts';
import type { ToolObservation } from '../brain.ts';

type Turn = { id: string; session_id: string; input_hash: string; status: string; question: string | null; answer: string | null };
export class ConversationStore {
  private db: Database.Database;
  private safe: (text: string) => string;
  private auditPath?: string;
  constructor(filename: string, options: { secrets?: string[]; auditPath?: string } = {}) {
    this.safe = redactor(options.secrets ?? []); this.auditPath = options.auditPath;
    this.db = openDatabase(filename);
    const interrupted = this.db.prepare("SELECT id FROM turns WHERE status='processing'").all() as { id: string }[];
    this.db.prepare("UPDATE turns SET status='cancelled',reason='process_interrupted',ended_at=? WHERE status='processing'").run(new Date().toISOString());
    for (const turn of interrupted) this.export(turn.id);
  }
  createSession(): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO sessions(id,created_at) VALUES (?,?)').run(id, new Date().toISOString());
    return id;
  }
  resolveSession(candidate?: string | null): { id: string; isNew: boolean } {
    if (candidate && candidate.length <= 80 && this.db.prepare('SELECT id FROM sessions WHERE id=?').get(candidate)) return { id: candidate, isNew: false };
    return { id: this.createSession(), isNew: true };
  }
  nextEpoch(sessionId: string): number {
    const row = this.db.prepare('UPDATE sessions SET connection_epoch=connection_epoch+1 WHERE id=? RETURNING connection_epoch').get(sessionId) as { connection_epoch: number };
    return row.connection_epoch;
  }
  scheduleGreeting(sessionId: string) { this.db.prepare('UPDATE sessions SET greeting_scheduled=1 WHERE id=?').run(sessionId); }
  history(sessionId: string): ChatMessage[] {
    return this.db.prepare('SELECT role,content FROM (SELECT id,role,content FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 12) ORDER BY id').all(sessionId) as ChatMessage[];
  }
  beginTurn(sessionId: string, epoch: number, turnId: string, audio: Buffer): { created: boolean; status?: string; answer?: string } {
    const hash = createHash('sha256').update(audio).digest('hex');
    const previous = this.db.prepare('SELECT * FROM turns WHERE id=?').get(turnId) as Turn | undefined;
    if (previous) {
      if (previous.session_id !== sessionId || previous.input_hash !== hash) throw new StorageError('回合身份与提交内容冲突。');
      return { created: false, status: previous.status, answer: previous.answer ?? undefined };
    }
    this.db.prepare("INSERT INTO turns(id,session_id,connection_epoch,input_hash,status,started_at) VALUES (?,?,?,?,'processing',?)").run(turnId, sessionId, epoch, hash, new Date().toISOString());
    return { created: true };
  }
  question(turnId: string, text: string) { this.db.prepare("UPDATE turns SET question=? WHERE id=? AND status='processing'").run(this.safe(text), turnId); }
  stage(turnId: string, phase: string, elapsedMs: number) {
    this.db.prepare('INSERT INTO turn_events(turn_id,phase,at,elapsed_ms) VALUES (?,?,?,?)').run(turnId, phase, new Date().toISOString(), elapsedMs);
  }
  metric(turnId: string, sessionId: string, epoch: number, value: unknown) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 300000) return;
    const turn = this.db.prepare('SELECT timings_json FROM turns WHERE id=? AND session_id=? AND connection_epoch=?').get(turnId, sessionId, epoch) as { timings_json: string } | undefined;
    if (!turn) return;
    const timings = JSON.parse(turn.timings_json);
    if (timings.firstAudioMs !== undefined) return;
    timings.firstAudioMs = value;
    this.db.prepare('UPDATE turns SET timings_json=? WHERE id=?').run(JSON.stringify(timings), turnId);
    this.export(turnId, 'turn.metric');
  }
  tool(turnId: string, observation: ToolObservation) {
    this.db.prepare('INSERT INTO tool_attempts(turn_id,ordinal,name,executed,status,input_json,result_json,duration_ms) VALUES (?,?,?,?,?,?,?,?)').run(turnId, observation.ordinal, this.safe(observation.name).slice(0, 64), observation.executed ? 1 : 0, observation.status, this.safe(JSON.stringify(observation.input ?? null)), this.safe(JSON.stringify(observation.result)), observation.durationMs);
    this.export(turnId, 'tool.attempt');
  }
  timings(turnId: string, values: Record<string, number>) {
    const row = this.db.prepare('SELECT timings_json FROM turns WHERE id=?').get(turnId) as { timings_json: string } | undefined;
    if (row) this.db.prepare('UPDATE turns SET timings_json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.timings_json), ...values }), turnId);
  }
  complete(turnId: string, answer: string, timings: Record<string, unknown>, owns: () => boolean) {
    this.db.transaction(() => {
      const turn = this.db.prepare('SELECT * FROM turns WHERE id=?').get(turnId) as Turn | undefined;
      if (!owns() || !turn || turn.status !== 'processing' || !turn.question) throw new StorageError('回合已失效，不能提交。');
      answer = this.safe(answer);
      const existing = this.db.prepare('SELECT timings_json FROM turns WHERE id=?').get(turnId) as { timings_json: string };
      const timestamp = new Date().toISOString();
      const insert = this.db.prepare('INSERT INTO messages(session_id,turn_id,role,content,created_at) VALUES (?,?,?,?,?)');
      insert.run(turn.session_id, turnId, 'user', turn.question, timestamp);
      insert.run(turn.session_id, turnId, 'assistant', answer, timestamp);
      this.db.prepare("UPDATE turns SET status='completed',answer=?,ended_at=?,timings_json=? WHERE id=?").run(answer, timestamp, JSON.stringify({ ...JSON.parse(existing.timings_json), ...timings }), turnId);
    })();
    this.export(turnId);
  }
  terminate(turnId: string, status: 'cancelled' | 'failed', reason: string) {
    const result = this.db.prepare("UPDATE turns SET status=?,reason=?,ended_at=? WHERE id=? AND status='processing'").run(status, reason, new Date().toISOString(), turnId);
    if (result.changes) this.export(turnId);
  }
  private export(turnId: string, event = 'turn.terminal') {
    if (!this.auditPath) return;
    try {
      mkdirSync(dirname(this.auditPath), { recursive: true });
      const record = auditRecords(this.db, { turnId })[0];
      appendFileSync(this.auditPath, this.safe(JSON.stringify({ event, ...record })) + '\n', 'utf8');
    } catch { console.warn(JSON.stringify({ event: 'audit.export_failed', turnId, code: 'append_failed' })); }
  }
  close() { this.db.close(); }
}
