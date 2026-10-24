import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { FrontendMiddleware } from './app.ts';

export class FrontendError extends Error {}

export function staticFrontend(directory = 'dist'): FrontendMiddleware {
  const root = resolve(directory);
  if (!existsSync(resolve(root, 'index.html'))) throw new FrontendError('请先运行 npm run build，再启动正式模式。');
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.vrm': 'model/gltf-binary', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
  return (request, response, next) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') { next(); return; }
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname); }
    catch { response.writeHead(400); response.end(); return; }
    const filename = resolve(root, pathname === '/' ? 'index.html' : '.' + pathname);
    const child = relative(root, filename);
    if (child.startsWith('..') || isAbsolute(child) || !types[extname(filename)]) { next(); return; }
    let size: number;
    try { const info = statSync(filename); if (!info.isFile()) { next(); return; } size = info.size; }
    catch { next(); return; }
    response.writeHead(200, { 'Content-Type': types[extname(filename)], 'Content-Length': size });
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = createReadStream(filename); stream.on('error', () => response.destroy()); stream.pipe(response);
  };
}
