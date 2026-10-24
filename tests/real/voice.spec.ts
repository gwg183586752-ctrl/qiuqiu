import { test, expect, chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pcmToWav } from '../../src/server/cloud/audio.ts';
import { loadEnvFile } from 'node:process';
import { readConfig } from '../../src/server/config.ts';

function sourceHash() {
  const hash = createHash('sha256');
  for (const entry of readdirSync('src', { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).sort((a, b) => (a.parentPath + a.name).localeCompare(b.parentPath + b.name))) hash.update(entry.parentPath + entry.name).update(readFileSync(join(entry.parentPath, entry.name)));
  return hash.digest('hex');
}

test('固定语音在真实Chrome与MiMo之间完成基线或Agent演出并导出原始样本', async ({ baseURL }) => {
  const manifest = JSON.parse(readFileSync('docs/implementation/fixtures/manifest.json', 'utf8')) as { name: string; text: string; path: string }[];
  const brain = process.env.REAL_BRAIN_MODE ?? 'baseline';
  const directory = resolve('.cache/measurements/' + brain + '-' + Date.now()); mkdirSync(directory, { recursive: true });
  const samples: Record<string, unknown>[] = [];
  loadEnvFile('.env'); const config = readConfig({ ...process.env, BRAIN_MODE: brain }); const initialHash = sourceHash();
  const save = () => writeFileSync(join(directory, 'samples.json'), JSON.stringify({ brain, sourceSha256: initialHash, evidence: 'real-browser-real-cloud-synthetic-microphone', models: { chat: config.chatModel, asr: config.asrModel, tts: config.ttsModel, voice: config.voice, thinking: 'disabled' }, audio: { browserCaptureRate: 16000, encoding: 'PCM16-mono-WAV', playbackRate: 24000 }, warmupPerClass: 1, measuredPerClass: 3, node: process.version, samples }, null, 2));
  let browserVersion = '';
  for (const fixture of manifest) {
    const original = readFileSync(fixture.path); const rate = original.readUInt32LE(24);
    const padded = pcmToWav(Buffer.concat([Buffer.alloc(rate * 2), original.subarray(44), Buffer.alloc(rate * 2)]), rate);
    const wavPath = join(directory, fixture.name + '.wav'); writeFileSync(wavPath, padded);
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-audio-capture=' + wavPath] });
    browserVersion = browser.version();
    try {
      for (let repeat = 0; repeat < 4; repeat++) {
        const sample: Record<string, unknown> = { category: fixture.name, prompt: fixture.text, audioSha256: createHash('sha256').update(original).digest('hex'), warmup: repeat === 0, repeat, startedAt: new Date().toISOString(), browserVersion, input: 'synthetic microphone using real MiMo TTS fixture', success: false };
        samples.push(sample); save();
        const context = await browser.newContext({ permissions: ['microphone'] }); const page = await context.newPage();
        page.on('websocket', socket => {
          socket.on('framesent', frame => {
            try { const message = JSON.parse(String(frame.payload)); if (message.type === 'metric') sample.firstAudioMs = message.firstAudioMs; } catch {}
          });
          socket.on('framereceived', frame => {
            try {
              const message = JSON.parse(String(frame.payload));
              if (message.type === 'transcript') sample.transcript = message.text;
              if (message.type === 'turn.done' && !message.greeting) { sample.answer = message.answer; sample.timings = message.timings; sample.turnId = message.turnId; sample.sessionId = message.sessionId; }
              if (message.type === 'turn.error') sample.protocolError = message.code;
            } catch {}
          });
        });
        try {
          await page.goto(baseURL!);
          await page.getByRole('button', { name: '开启声音', exact: true }).click();
          await expect(page.getByRole('button', { name: '开始录音', exact: true })).toBeEnabled();
          await page.getByRole('button', { name: '开始录音', exact: true }).click();
          await expect(page.getByRole('button', { name: '结束并发送', exact: true })).toBeEnabled();
          await page.waitForTimeout(padded.length / (rate * 2) * 1000);
          await page.getByRole('button', { name: '结束并发送', exact: true }).click();
          await expect(page.getByRole('button', { name: '开始录音', exact: true })).toBeEnabled({ timeout: 90000 });
          expect(typeof sample.transcript).toBe('string'); expect(typeof sample.answer).toBe('string'); expect(typeof sample.firstAudioMs).toBe('number');
          sample.transportSuccess = true;
          if (brain === 'agent' && fixture.name === 'time') expect(Number((sample.timings as Record<string, number>)?.actualToolAttempts)).toBeGreaterThan(0);
          const normalize = (value: string) => value.replace(/[\p{P}\p{Z}\s]/gu, '');
          expect(normalize(String(sample.transcript))).toContain(normalize(fixture.text));
          sample.success = true;
          await page.screenshot({ path: join(directory, fixture.name + '-' + repeat + '.png'), fullPage: true });
        } catch { sample.failure = '未完成浏览器语音回合，保留协议错误码及已有指标'; }
        finally { sample.endedAt = new Date().toISOString(); save(); await context.close(); }
      }
    } finally { await browser.close(); }
  }
  console.log(JSON.stringify({ directory, total: samples.length, successful: samples.filter(s => s.success).length, browserVersion }));
  expect(sourceHash(), '采样期间源代码必须保持冻结').toBe(initialHash);
  expect(samples.filter(s => !s.success)).toHaveLength(0);
});
