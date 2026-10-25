import { test, expect } from '@playwright/test';

test('默认输入无声时可看到设备并切换真实麦克风，音量恢复后只提交有效录音', async ({ page }) => {
  let submissions = 0;
  page.on('websocket', socket => socket.on('framesent', frame => { try { if (JSON.parse(String(frame.payload)).type === 'turn.submit') submissions++; } catch {} }));
  await page.addInitScript(() => {
    let selected = '';
    navigator.mediaDevices.enumerateDevices = async () => [
      { deviceId: 'default', groupId: 'fixture', kind: 'audioinput', label: '默认 - 真实麦克风', toJSON() { return {}; } },
      { deviceId: 'virtual-fixture', groupId: 'fixture', kind: 'audioinput', label: '虚拟音频输入', toJSON() { return {}; } },
      { deviceId: 'real-fixture', groupId: 'fixture', kind: 'audioinput', label: '真实麦克风', toJSON() { return {}; } },
    ];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints = {}) => {
      const audio = constraints.audio as MediaTrackConstraints;
      const device = audio.deviceId;
      selected = typeof device === 'object' && !Array.isArray(device) ? String(device.exact ?? '') : '';
      const { deviceId: _device, ...rest } = audio;
      const stream = await capture({ ...constraints, audio: rest });
      Object.defineProperty(stream.getAudioTracks()[0], 'label', { value: selected === 'real-fixture' ? '真实麦克风' : '虚拟音频输入' });
      return stream;
    };
    const NativeNode = AudioWorkletNode; const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage')!;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(...args: ConstructorParameters<typeof NativeNode>) {
        super(...args); const port = this.port;
        Object.defineProperty(port, 'onmessage', { configurable: true,
          set(callback: MessagePort['onmessage']) {
            descriptor.set!.call(port, callback ? (event: MessageEvent) => {
              const received = selected === 'real-fixture' ? event : new MessageEvent('message', { data: new Float32Array(event.data.length) });
              callback.call(port, received);
            } : null);
          },
        });
      }
    };
  });
  await page.goto('/'); await page.getByRole('button', { name: '开启声音' }).click();
  await page.getByRole('button', { name: '开始录音' }).click(); await expect(page.getByRole('button', { name: '结束并发送' })).toBeEnabled();
  await page.waitForTimeout(700); await page.getByRole('button', { name: '结束并发送' }).click();
  await expect(page.getByRole('alert')).toContainText('没有听到有效声音');
  await expect(page.getByLabel('输入设备')).toContainText('浏览器默认输入');
  await expect(page.getByText('当前输入：虚拟音频输入')).toBeVisible(); expect(submissions).toBe(0);
  await page.getByLabel('输入设备').selectOption('real-fixture'); await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('button', { name: '结束并发送' })).toBeEnabled();
  await expect.poll(async () => Number(await page.getByRole('meter', { name: '麦克风音量' }).getAttribute('value'))).toBeGreaterThan(0);
  await page.waitForTimeout(700); await page.getByRole('button', { name: '结束并发送' }).click();
  await expect(page.getByRole('button', { name: '开始录音' })).toBeEnabled(); expect(submissions).toBe(1);
});
