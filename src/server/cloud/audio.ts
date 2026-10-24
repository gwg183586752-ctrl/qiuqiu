export function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  if (pcm.length % 2) throw new Error('PCM16 长度必须为偶数');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function simulatedWav(): Buffer {
  const rate = 24000;
  const pcm = Buffer.alloc(rate * 2 * 1.8);
  for (let i = 0; i < pcm.length / 2; i++) {
    const envelope = Math.sin(Math.PI * i / (pcm.length / 2)) ** 2;
    pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / rate) * envelope * 4000), i * 2);
  }
  return pcmToWav(pcm, rate);
}
