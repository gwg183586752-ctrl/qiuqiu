export class BrowserRecorder {
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private chunks: Float32Array[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private openingTimer?: ReturnType<typeof setTimeout>;
  private cancelOpening?: () => void;
  private generation = 0;

  async start(maxSeconds: number, onLimit: () => void, onFailure: (message: string) => void = () => {}) {
    this.cancel();
    const generation = this.generation;
    const context = new AudioContext({ sampleRate: 16000 }); this.context = context;
    try {
      await context.resume();
      if (generation !== this.generation) throw new DOMException('采集已取消', 'AbortError');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); throw new DOMException('采集已取消', 'AbortError'); }
      this.stream = stream;
      await context.audioWorklet.addModule('/audio-recorder.worklet.js');
      if (generation !== this.generation) throw new DOMException('采集已取消', 'AbortError');
      const source = context.createMediaStreamSource(stream); this.source = source;
      const node = new AudioWorkletNode(context, 'microphone-capture'); this.node = node;
      const mute = context.createGain(); mute.gain.value = 0;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const ready = (error?: Error) => {
          if (settled) return;
          settled = true; clearTimeout(this.openingTimer); this.openingTimer = undefined; this.cancelOpening = undefined;
          if (error) reject(error); else resolve();
        };
        this.cancelOpening = () => ready(new DOMException('采集已取消', 'AbortError'));
        this.openingTimer = setTimeout(() => ready(new Error('麦克风还没准备好，请重试。')), 5000);
        node.port.onmessage = event => {
          if (generation !== this.generation || !(event.data instanceof Float32Array) || !event.data.length) return;
          this.chunks.push(event.data); ready();
        };
        node.onprocessorerror = () => {
          const error = new Error('麦克风采集遇到问题，请重试。');
          if (!settled) ready(error);
          else if (generation === this.generation) { this.cancel(); onFailure(error.message); }
        };
        try {
          source.connect(node); node.connect(mute); mute.connect(context.destination);
          this.timer = setTimeout(() => { this.cancel(); onLimit(); }, maxSeconds * 1000);
        } catch (error) { ready(error instanceof Error ? error : new Error('麦克风暂时不可用，请重试。')); }
      });
      if (generation !== this.generation) throw new DOMException('采集已取消', 'AbortError');
    } catch (error) { if (generation === this.generation) this.cancel(); throw error; }
  }

  async finish(): Promise<Uint8Array> {
    if (!this.context || !this.stream) throw new Error('麦克风没有开始录音，请重试。');
    const sampleRate = this.context.sampleRate;
    const chunks = this.chunks;
    this.cancel();
    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    if (length < sampleRate * 0.15) throw new Error('这段录音太短了，请再说一次。');
    const wav = new ArrayBuffer(44 + length * 2); const view = new DataView(wav);
    const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, length * 2, true);
    let offset = 44; let peak = 0;
    for (const chunk of chunks) for (const sample of chunk) {
      peak = Math.max(peak, Math.abs(sample));
      const value = Math.max(-1, Math.min(1, sample)); view.setInt16(offset, Math.round(value * (value < 0 ? 32768 : 32767)), true); offset += 2;
    }
    if (peak < 0.0035) throw new Error('没有听到有效声音，请靠近麦克风再试。');
    return new Uint8Array(wav);
  }

  cancel() {
    this.generation++; this.cancelOpening?.(); this.cancelOpening = undefined;
    clearTimeout(this.timer); clearTimeout(this.openingTimer); this.timer = undefined; this.openingTimer = undefined;
    if (this.node) { this.node.port.onmessage = null; this.node.onprocessorerror = null; this.node.disconnect(); }
    this.source?.disconnect(); this.stream?.getTracks().forEach(track => track.stop());
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => {});
    this.stream = undefined; this.context = undefined; this.node = undefined; this.source = undefined; this.chunks = [];
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) result += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(result);
}
