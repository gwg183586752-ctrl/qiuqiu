import { test, expect, chromium } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startServer } from '../../src/server/app.ts';
import { staticFrontend } from '../../src/server/frontend.ts';
import { readConfig } from '../../src/server/config.ts';
import { createFakeCloud } from '../../src/server/cloud/fake.ts';
import type { ChatMessage } from '../../src/server/cloud/types.ts';

test('Chrome和Edge分别持久保存会话，任一浏览器发言不会接管另一浏览器', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  const edge = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-audio-capture=' + resolve('.cache/browser/microphone.wav')] });
  const edgeContext = await edge.newContext({ permissions: ['microphone'] }); const other = await edgeContext.newPage();
  try {
    for (const view of [page, other]) { await view.goto(baseURL!); await view.getByRole('button', { name: '开启声音' }).click(); await expect(view.getByRole('button', { name: '开始录音' })).toBeEnabled(); }
    const ids = await Promise.all([page, other].map(view => view.evaluate(() => localStorage.getItem('qiuqiu.session.v1'))));
    expect(ids[0]).toBeTruthy(); expect(ids[0]).not.toBe(ids[1]);
    for (const view of [page, other]) {
      await view.getByRole('button', { name: '开始录音' }).click(); await expect(view.getByRole('button', { name: '结束并发送' })).toBeEnabled();
      await view.waitForTimeout(700); await view.getByRole('button', { name: '结束并发送' }).click(); await expect(view.getByRole('button', { name: '开始录音' })).toBeEnabled();
    }
    for (const [index, view] of [page, other].entries()) { await view.reload(); await expect(view.getByRole('button', { name: '开始录音' })).toBeEnabled(); expect(await view.evaluate(() => localStorage.getItem('qiuqiu.session.v1'))).toBe(ids[index]); }
    await page.screenshot({ path: 'docs/implementation/evidence/10-chrome.png', fullPage: true }); await other.screenshot({ path: 'docs/implementation/evidence/10-edge.png', fullPage: true });
  } finally { await edge.close(); }
});

test('构建产物在关闭页面及服务重启后续聊，不重播开场白和历史声音', async ({ page, context }) => {
  test.setTimeout(60000); mkdirSync('.cache/tests', { recursive: true }); const directory = mkdtempSync('.cache/tests/browser-restart-');
  const cloud = createFakeCloud(); let received: ChatMessage[] = [];
  cloud.streamReply = async function* (messages) { received = messages; yield '<emo:happy>这一轮已经保存。'; };
  const config = readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'browser-restart-token', PORT: '0', DATABASE_PATH: join(directory, 'conversation.sqlite'), AUDIT_PATH: join(directory, 'turns.jsonl') });
  let app = await startServer({ config, cloud, frontend: staticFrontend() }); const url = app.url;
  try {
    await page.goto(url); await page.getByRole('button', { name: '开启声音' }).click(); await page.getByRole('button', { name: '开始录音' }).click();
    await expect(page.getByRole('button', { name: '结束并发送' })).toBeEnabled(); await page.waitForTimeout(700); await page.getByRole('button', { name: '结束并发送' }).click();
    await expect(page.getByRole('button', { name: '开始录音' })).toBeEnabled(); const session = await page.evaluate(() => localStorage.getItem('qiuqiu.session.v1')); await page.close();
    await app.close(); app = await startServer({ config: { ...config, port: Number(new URL(url).port) }, cloud, frontend: staticFrontend() });
    const reopened = await context.newPage(); await reopened.goto(url); await expect(reopened.getByRole('button', { name: '开始录音' })).toBeEnabled();
    expect(await reopened.evaluate(() => localStorage.getItem('qiuqiu.session.v1'))).toBe(session); await expect(reopened.getByTestId('subtitle')).not.toHaveText('嗨，我是小糖，今天想聊点什么呀？');
    await reopened.getByRole('button', { name: '开始录音' }).click(); await expect(reopened.getByRole('button', { name: '结束并发送' })).toBeEnabled(); await reopened.waitForTimeout(700); await reopened.getByRole('button', { name: '结束并发送' }).click();
    await expect(reopened.getByRole('button', { name: '开始录音' })).toBeEnabled(); expect(received.slice(1, -1)).toEqual([{ role: 'user', content: '你好，小糖。' }, { role: 'assistant', content: '这一轮已经保存。' }]);
  } finally { await app.close(); }
});
