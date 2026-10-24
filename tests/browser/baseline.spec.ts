import { test, expect } from '@playwright/test';
import { simulatedWav } from '../../src/server/cloud/audio.ts';

test('乱序分段按序播放，已播片段的迟到重复不会阻塞播放结束', async ({ page }) => {
  let duplicate: (() => void) | undefined;
  await page.routeWebSocket('**/ws?*', socket => {
    const envelope = { version: 1, sessionId: 'queue-fixture', connectionEpoch: 1 };
    const send = (event: object) => socket.send(JSON.stringify({ ...envelope, ...event }));
    const speech = (sequence: number, text: string) => {
      const identity = { turnId: 'greeting-queue', sequence, segmentId: 'greeting-queue:' + sequence };
      send({ type: 'speech.segment', ...identity, text }); send({ type: 'speech.audio', ...identity, data: simulatedWav().toString('base64'), mimeType: 'audio/wav', final: true });
    };
    socket.onMessage(raw => {
      if (JSON.parse(String(raw)).type !== 'hello') return;
      send({ type: 'turn.state', turnId: 'greeting-queue', state: 'synthesizing' });
      speech(1, '第二句话。'); speech(0, '第一句话。');
      send({ type: 'turn.done', turnId: 'greeting-queue', answer: '第一句话。第二句话。', greeting: true });
      duplicate = () => speech(0, '迟到的第一句不再播放。');
    });
    send({ type: 'session.ready', isNew: true, mode: 'fake', maxRecordingSeconds: 30 });
  });
  await page.goto('/'); await page.getByRole('button', { name: '开启声音' }).click();
  await expect(page.getByTestId('subtitle')).toHaveText('第一句话。');
  await expect(page.getByRole('button', { name: '请稍等', exact: true })).toBeDisabled();
  await expect(page.getByTestId('subtitle')).toHaveText('第二句话。'); duplicate!();
  await expect(page.getByRole('button', { name: '开始录音' })).toBeEnabled();
  await expect(page.getByTestId('subtitle')).toHaveText('第二句话。');
});

test('错误共享口令显示校验失败且不创建WS，修正后可重试', async ({ page }) => {
  let upgrades = 0; page.on('websocket', socket => { if (new URL(socket.url()).pathname === '/ws') upgrades++; });
  await page.route('**/client-config', async route => {
    const response = await route.fetch(); const body = await response.json();
    await route.fulfill({ response, json: { ...body, accessToken: 'wrong-test-token' } });
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('连接校验失败');
  await page.waitForTimeout(1400); expect(upgrades).toBe(0);
  await page.unroute('**/client-config');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('button', { name: '开启声音' })).toBeEnabled();
  expect(upgrades).toBe(1);
});

test('同浏览器新标签接管会释放麦克风，刷新续聊不重播开场白', async ({ page, context }) => {
  let upgrades = 0; page.on('websocket', socket => { if (new URL(socket.url()).pathname === '/ws') upgrades++; });
  await page.addInitScript(() => {
    const scope = window as typeof window & { capturedStreams: MediaStream[] }; scope.capturedStreams = [];
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => { const stream = await getUserMedia(options); scope.capturedStreams.push(stream); return stream; };
  });
  await page.goto('/'); await page.getByRole('button', { name: '开启声音' }).click();
  await page.getByRole('button', { name: '开始录音' }).click();
  await expect(page.getByRole('button', { name: '结束并发送' })).toBeEnabled();
  const second = await context.newPage(); await second.goto('/');
  await expect(second.getByRole('button', { name: '开始录音' })).toBeEnabled();
  await expect(page.getByRole('status')).toContainText('会话已在其他页面继续');
  await expect.poll(() => page.evaluate(() => (window as typeof window & { capturedStreams: MediaStream[] }).capturedStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  await second.reload(); await expect(second.getByRole('button', { name: '开始录音' })).toBeEnabled();
  await expect(second.getByTestId('subtitle')).not.toHaveText('嗨，我是小糖，今天想聊点什么呀？');
  await page.waitForTimeout(1400); expect(upgrades).toBe(1);
});

test('麦克风拒绝后有明确提示，后续允许时可以恢复并在结束后释放', async ({ page }) => {
  await page.addInitScript(() => {
    const scope = window as typeof window & { allowCapture: boolean; capturedStreams: MediaStream[] }; scope.allowCapture = false; scope.capturedStreams = [];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => {
      if (!scope.allowCapture) throw new DOMException('denied', 'NotAllowedError');
      const stream = await capture(options); scope.capturedStreams.push(stream); return stream;
    };
  });
  await page.goto('/'); await page.getByRole('button', { name: '开启声音' }).click();
  await page.getByRole('button', { name: '开始录音' }).click();
  await expect(page.getByRole('alert')).toContainText('请允许使用麦克风');
  await page.evaluate(() => { (window as typeof window & { allowCapture: boolean }).allowCapture = true; });
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('button', { name: '结束并发送' })).toBeEnabled();
  await page.waitForTimeout(700); await page.getByRole('button', { name: '结束并发送' }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { capturedStreams: MediaStream[] }).capturedStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
});

test('接管终态立即停止已开始的声音并阻止自动重连与迟到播放', async ({ page }) => {
  let connections = 0;
  let replace: (() => void) | undefined;
  await page.addInitScript(() => {
    const scope = window as typeof window & { observedAudio: HTMLMediaElement[] };
    scope.observedAudio = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { scope.observedAudio.push(this); return play.call(this); };
  });
  await page.routeWebSocket('**/ws?*', socket => {
    connections++;
    const envelope = { version: 1, sessionId: 'fixture-session', connectionEpoch: 1 };
    const send = (event: object) => socket.send(JSON.stringify({ ...envelope, ...event }));
    const segment = { turnId: 'greeting-fixture', segmentId: 'greeting-fixture:0', sequence: 0 };
    socket.onMessage(raw => {
      if (JSON.parse(String(raw)).type !== 'hello') return;
      send({ type: 'turn.state', turnId: segment.turnId, state: 'synthesizing' });
      send({ type: 'speech.segment', ...segment, text: '用于验证声音停止。', action: 'nod', emotion: 'happy' });
      send({ type: 'speech.audio', ...segment, data: simulatedWav().toString('base64'), mimeType: 'audio/wav', final: true });
      send({ type: 'turn.done', turnId: segment.turnId, answer: '用于验证声音停止。', greeting: true });
      replace = () => {
        send({ type: 'session.replaced', message: '会话已在其他页面继续' });
        send({ type: 'speech.segment', ...segment, text: '这句迟到字幕不该显示。' });
        socket.close({ code: 4001, reason: 'replaced' });
      };
    });
    send({ type: 'session.ready', isNew: true, mode: 'fake', maxRecordingSeconds: 30 });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '开启声音' }).click();
  await expect(page.getByTestId('subtitle')).toHaveText('用于验证声音停止。');
  replace!();
  await expect(page.getByRole('status')).toContainText('会话已在其他页面继续');
  await expect(page.getByRole('button', { name: '已由其他页面接管' })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { observedAudio: HTMLMediaElement[] }).observedAudio.every(audio => audio.paused && !audio.getAttribute('src')))).toBe(true);
  await page.waitForTimeout(1400);
  expect(connections).toBe(1);
  await expect(page.getByTestId('subtitle')).not.toHaveText('这句迟到字幕不该显示。');
});

test('页面加载数字人并由原有按钮激活模拟开场白', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /小糖/ })).toBeVisible();
  await expect(page.getByRole('img', { name: '小糖数字人' })).toBeVisible();
  await expect(page.getByRole('button', { name: '开启声音' })).toBeEnabled();
  await page.getByRole('button', { name: '开启声音' }).click();
  await expect(page.getByTestId('subtitle')).toHaveText('嗨，我是小糖，今天想聊点什么呀？');
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'docs/implementation/evidence/03-speaking.png', fullPage: true });
  await expect(page.getByRole('button', { name: '开始录音' })).toBeEnabled();
  await expect(page.getByRole('status')).toContainText('模拟');
  await page.screenshot({ path: 'docs/implementation/evidence/03-baseline.png', fullPage: true });
});

test('角色加载失败会提示，重试后重新加载角色再进入对话', async ({ page }) => {
  await page.route('**/models/*.vrm', route => route.abort());
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('角色暂时没有加载成功');
  await expect(page.getByRole('img', { name: '小糖数字人' })).toHaveAttribute('data-ready', 'false');
  await page.unroute('**/models/*.vrm');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('img', { name: '小糖数字人' })).toHaveAttribute('data-ready', 'true');
  await expect(page.getByRole('button', { name: '开启声音' })).toBeEnabled();
});

test('模拟麦克风经真实浏览器编码WAV并完成两轮半双工演出', async ({ page }) => {
  const recordings: Buffer[] = [];
  const actions = new Set<string>();
  page.on('websocket', socket => {
    socket.on('framesent', frame => {
      try { const event = JSON.parse(String(frame.payload)); if (event.type === 'turn.submit') recordings.push(Buffer.from(event.audio.data, 'base64')); } catch {}
    });
    socket.on('framereceived', frame => {
      try { const event = JSON.parse(String(frame.payload)); if (event.type === 'speech.segment' && !event.turnId.startsWith('greeting-') && event.action) actions.add(event.action); } catch {}
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '开启声音' }).click();
  await expect(page.getByRole('button', { name: '开始录音' })).toBeEnabled();
  for (let round = 0; round < 2; round++) {
    await page.getByRole('button', { name: '开始录音' }).click();
    await expect(page.getByRole('button', { name: '结束并发送' })).toBeEnabled();
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: '结束并发送' }).click();
    await expect(page.getByRole('button', { name: '请稍等', exact: true })).toBeDisabled();
    const first = round === 0 ? '你好呀，很高兴和你聊足球！' : '讲到喜欢的球队就有好多故事。';
    await expect(page.getByTestId('subtitle')).toHaveText(first);
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'docs/implementation/evidence/03-action-' + (round === 0 ? 'nod' : 'tilt') + '.png', fullPage: true });
    const second = round === 0 ? '今天想聊哪支球队？' : '我在认真听，你接着说呀。';
    await expect(page.getByTestId('subtitle')).toHaveText(second);
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'docs/implementation/evidence/03-action-' + (round === 0 ? 'shake' : 'lean') + '.png', fullPage: true });
    await expect(page.getByRole('button', { name: '开始录音' })).toBeEnabled();
  }
  expect(recordings).toHaveLength(2);
  for (const wav of recordings) {
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.length).toBeGreaterThan(4000);
  }
  expect([...actions].sort()).toEqual(['lean', 'nod', 'shake', 'tilt']);
});

test('等待真实采样就绪后才进入可结束的录音状态', async ({ page }) => {
  let submitted = 0;
  page.on('websocket', socket => socket.on('framesent', frame => {
    try { if (JSON.parse(String(frame.payload)).type === 'turn.submit') submitted++; } catch {}
  }));
  await page.addInitScript(() => {
    const scope = window as typeof window & { captureFixtureUsed: number; releaseCaptureSamples(): void };
    scope.captureFixtureUsed = 0;
    const NativeNode = AudioWorkletNode;
    const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage')!;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(...args: ConstructorParameters<typeof NativeNode>) {
        super(...args); scope.captureFixtureUsed++;
        const port = this.port;
        let handler: MessagePort['onmessage'] = null;
        let released = false;
        const held: { event: MessageEvent; callback: NonNullable<MessagePort['onmessage']> }[] = [];
        scope.releaseCaptureSamples = () => {
          released = true;
          for (const item of held.splice(0)) if (handler === item.callback) item.callback.call(port, item.event);
        };
        Object.defineProperty(port, 'onmessage', {
          configurable: true, get: () => handler,
          set(value: MessagePort['onmessage']) {
            handler = value;
            descriptor.set!.call(port, value ? (event: MessageEvent) => {
              if (!released && ArrayBuffer.isView(event.data)) held.push({ event, callback: value });
              else value.call(port, event);
            } : null);
          },
        });
      }
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: '开启声音' }).click();
  await page.getByRole('button', { name: '开始录音' }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { captureFixtureUsed: number }).captureFixtureUsed)).toBe(1);
  await expect(page.getByRole('button', { name: '请稍等', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as typeof window & { releaseCaptureSamples(): void }).releaseCaptureSamples());
  await expect(page.getByRole('button', { name: '结束并发送' })).toBeEnabled();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: '结束并发送' }).click();
  await expect.poll(() => submitted).toBe(1);
  await expect(page.getByRole('alert')).not.toBeVisible();
});
