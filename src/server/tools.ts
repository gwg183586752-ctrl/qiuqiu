import { z } from 'zod';

export const timeInputSchema = z.object({ timeZone: z.enum(['Asia/Shanghai', 'UTC']).optional().default('Asia/Shanghai') }).strict();
export const TIME_TOOL = { name: 'get_server_time', description: '读取服务器当前真实时间。支持 Asia/Shanghai（北京时间）或 UTC；不提供比分、赛程或足球数据。' } as const;
export type TimeProbe = (timeZone: 'Asia/Shanghai' | 'UTC', signal: AbortSignal) => Promise<Record<string, string | number | boolean | null>>;
export const serverTime: TimeProbe = async (timeZone, signal) => {
  signal.throwIfAborted(); const now = new Date();
  return { iso: now.toISOString(), timeZone, localTime: new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now) };
};
