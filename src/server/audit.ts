import type Database from 'better-sqlite3';

export function redactor(secrets: string[]) {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  return (text: string) => {
    let result = text;
    for (const secret of values) result = result.replaceAll(secret, '<REDACTED>');
    return result.replace(/(?:wss?|https?):\/\/[^\s"<>]*[?&]token=[^\s"<>]*/gi, '<REDACTED_URL>');
  };
}

export function auditRecords(db: Database.Database, filter: { turnId?: string; sessionId?: string }) {
  const clause = filter.turnId ? 'id=?' : 'session_id=?';
  const records = db.prepare(`SELECT id AS turnId,session_id AS sessionId,connection_epoch AS connectionEpoch,status,started_at AS startedAt,ended_at AS endedAt,question,answer,reason,timings_json FROM turns WHERE ${clause} ORDER BY started_at,id`).all(filter.turnId ?? filter.sessionId) as Record<string, unknown>[];
  return records.map(record => {
    const { timings_json, ...rest } = record;
    return { ...rest, timings: JSON.parse(String(timings_json)),
      stages: db.prepare('SELECT phase,at,elapsed_ms AS elapsedMs FROM turn_events WHERE turn_id=? ORDER BY id').all(record.turnId),
      tools: db.prepare('SELECT ordinal,name,executed,status,input_json,result_json,duration_ms AS durationMs FROM tool_attempts WHERE turn_id=? ORDER BY ordinal').all(record.turnId).map(value => {
        const tool = value as Record<string, unknown>;
        const { input_json, result_json, ...fields } = tool;
        return { ...fields, executed: !!fields.executed, input: input_json ? JSON.parse(String(input_json)) : null, result: result_json ? JSON.parse(String(result_json)) : null };
      }),
    };
  });
}
