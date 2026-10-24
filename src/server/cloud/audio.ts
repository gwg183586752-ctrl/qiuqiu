import { pcm16MonoWav } from '../../shared/wav.ts';

export function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  return Buffer.from(pcm16MonoWav(pcm, sampleRate));
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
