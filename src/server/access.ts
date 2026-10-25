import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export function sameLocalOrigin(request: IncomingMessage): boolean {
  const host = request.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  const origin = request.headers.origin;
  if (origin && origin !== 'http://' + host) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    const path = request.url?.split('?')[0];
    return request.method === 'GET' && (path === '/' || path === '/index.html') && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
  }
  return true;
}

export function validToken(value: unknown, expected: string): boolean {
  if (typeof value !== 'string' || value.length > 4096) return false;
  const actual = Buffer.from(value); const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}
