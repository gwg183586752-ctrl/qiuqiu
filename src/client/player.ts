import type { Segment } from '../shared/protocol.ts';

interface Callbacks {
  onActivation(): void;
  onSegment(segment: Segment): void;
  onWaiting(): void;
  onComplete(turnId: string): void;
  onError(message: string): void;
  onFirstAudio(turnId: string): void;
}
interface Entry { segment?: Segment; data?: string }

export class SpeechPlayer {
  private callbacks: Callbacks;
  private audio = new Audio();
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private waveform = new Float32Array(256);
  private entries = new Map<number, Entry>();
  private turnId = '';
  private expected = 0;
  private done = false;
  private generation = 0;
  private currentUrl?: string;
  private playing = false;
  private activated = false;
  private firstPlayed = false;

  constructor(callbacks: Callbacks) { this.callbacks = callbacks; this.audio.preload = 'auto'; }

  begin(turnId: string) { this.stop(); this.turnId = turnId; this.done = false; }
  segment(turnId: string, segment: Segment) {
    if (turnId !== this.turnId || segment.sequence < this.expected) return;
    this.entries.set(segment.sequence, { ...this.entries.get(segment.sequence), segment }); this.next();
  }
  supply(turnId: string, sequence: number, data: string) {
    if (turnId !== this.turnId || sequence < this.expected) return;
    this.entries.set(sequence, { ...this.entries.get(sequence), data }); this.next();
  }
  finish(turnId: string) { if (turnId === this.turnId) { this.done = true; this.next(); } }

  async activate() {
    if (!this.context) {
      this.context = new AudioContext();
      this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 256;
      this.context.createMediaElementSource(this.audio).connect(this.analyser);
      this.analyser.connect(this.context.destination);
    }
    await this.context.resume();
    if (this.context.state !== 'running') throw new Error('请允许浏览器播放声音后再试。');
    this.activated = true; this.next();
  }

  volume = () => {
    if (!this.playing || !this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.waveform);
    let square = 0; for (const value of this.waveform) square += value * value;
    return Math.sqrt(square / this.waveform.length);
  };

  private next() {
    if (!this.turnId || this.currentUrl) return;
    if (this.done && this.entries.size === 0) {
      const id = this.turnId; this.turnId = ''; this.callbacks.onComplete(id); return;
    }
    const entry = this.entries.get(this.expected);
    if (!entry?.segment || !entry.data) { if (this.turnId) this.callbacks.onWaiting(); return; }
    if (!this.activated || this.context?.state !== 'running') { this.callbacks.onActivation(); return; }
    const generation = this.generation;
    const binary = atob(entry.data); const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    this.currentUrl = url; this.audio.src = url;
    this.audio.onplaying = () => {
      if (generation !== this.generation || this.playing) return;
      this.playing = true; this.callbacks.onSegment(entry.segment!);
      if (!this.firstPlayed) { this.firstPlayed = true; this.callbacks.onFirstAudio(this.turnId); }
    };
    this.audio.onended = () => {
      if (generation !== this.generation) return;
      this.playing = false; URL.revokeObjectURL(url); this.currentUrl = undefined;
      this.entries.delete(this.expected++); this.next();
    };
    this.audio.onerror = () => {
      if (generation === this.generation && this.currentUrl) this.callbacks.onError('这段声音没有播放成功，请再试一次。');
    };
    void this.audio.play().catch(error => {
      if (generation !== this.generation) return;
      URL.revokeObjectURL(url); this.currentUrl = undefined; this.playing = false;
      if (error instanceof DOMException && error.name === 'NotAllowedError') { this.activated = false; this.callbacks.onActivation(); }
      else this.callbacks.onError('声音暂时无法播放，请再试一次。');
    });
  }

  stop() {
    this.generation++; this.audio.onended = null; this.audio.onplaying = null; this.audio.onerror = null;
    this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load();
    if (this.currentUrl) URL.revokeObjectURL(this.currentUrl);
    this.currentUrl = undefined; this.entries.clear(); this.turnId = ''; this.expected = 0;
    this.done = false; this.playing = false; this.firstPlayed = false;
  }
  destroy() { this.stop(); void this.context?.close(); }
}
