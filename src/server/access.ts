import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export function sameLocalOrigin(request: IncomingMessage): boolean {
  const host = request.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  return !origin || origin === 'http://' + host;
}

export function validToken(value: unknown, expected: string): boolean {
  if (typeof value !== 'string' || value.length > 4096) return false;
  const actual = Buffer.from(value); const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}
