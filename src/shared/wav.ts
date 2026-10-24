export function pcm16MonoWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  if (pcm.length % 2 || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) throw new Error('PCM16 音频参数无效');
  const wav = new Uint8Array(44 + pcm.length); const view = new DataView(wav.buffer);
  const text = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + pcm.length, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, pcm.length, true); wav.set(pcm, 44);
  return wav;
}
