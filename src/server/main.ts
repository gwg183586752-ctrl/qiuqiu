import { startServer } from './app.ts';
import { readConfig, ConfigError } from './config.ts';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { staticFrontend, FrontendError } from './frontend.ts';
import type { ViteDevServer } from 'vite';

async function main() {
  if (existsSync('.env')) loadEnvFile('.env');
  const config = readConfig();
  let vite: ViteDevServer | undefined;
  let frontend;
  if (process.argv.includes('--production')) frontend = staticFrontend();
  else {
    const { createServer } = await import('vite');
    vite = await createServer({ server: { middlewareMode: true, hmr: false, host: '127.0.0.1' }, appType: 'spa' });
    frontend = vite.middlewares;
  }
  let app;
  try { app = await startServer({ config, frontend }); }
  catch (error) { await vite?.close(); throw error; }
  console.log(JSON.stringify({ event: 'server.ready', url: app.url, mode: config.cloudMode }));
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (stopping) return; stopping = true;
      void Promise.all([app.close(), vite?.close()]).then(() => { process.exitCode = 0; });
    });
  }
}
main().catch(error => {
  console.error(error instanceof ConfigError || error instanceof FrontendError ? error.message : '服务启动失败，请检查端口和运行环境。');
  process.exitCode = 1;
});
