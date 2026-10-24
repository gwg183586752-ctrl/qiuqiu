import { defineConfig } from '@playwright/test';

if (process.env.RUN_REAL_CLOUD !== '1') throw new Error('真实付费验收需显式设置 RUN_REAL_CLOUD=1。');
export default defineConfig({
  testDir: './tests/real', workers: 1, fullyParallel: false, timeout: 360000,
  expect: { timeout: 30000 },
  use: { baseURL: 'http://127.0.0.1:4174', trace: 'off', video: 'off', screenshot: 'only-on-failure' },
  webServer: {
    command: 'node --experimental-strip-types src/server/main.ts', url: 'http://127.0.0.1:4174/health',
    timeout: 30000, reuseExistingServer: false,
    env: { CLOUD_MODE: 'real', PORT: '4174', BRAIN_MODE: process.env.REAL_BRAIN_MODE ?? 'baseline', DATABASE_PATH: '.cache/real-browser.sqlite', AUDIT_PATH: '.cache/real-browser.jsonl' },
  },
});
