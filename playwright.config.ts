import { defineConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { simulatedWav } from './src/server/cloud/audio.ts';

mkdirSync('.cache/browser', { recursive: true });
const microphoneFixture = resolve('.cache/browser/microphone.wav');
writeFileSync(microphoneFixture, simulatedWav());

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 10000 },
  use: {
    channel: 'chrome', baseURL: 'http://127.0.0.1:4173', headless: true,
    permissions: ['microphone'], screenshot: 'only-on-failure', trace: 'retain-on-failure',
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-audio-capture=' + microphoneFixture] },
  },
  webServer: {
    command: 'node --experimental-strip-types src/server/main.ts',
    url: 'http://127.0.0.1:4173/health',
    timeout: 30000,
    reuseExistingServer: false,
    env: { CLOUD_MODE: 'fake', ACCESS_TOKEN: 'browser-test-token', PORT: '4173', BRAIN_MODE: 'baseline', DATABASE_PATH: '.cache/browser/football.sqlite' },
  },
});
