import type { CloudAdapters, ChatMessage } from './cloud/types.ts';
import { SentenceStream } from './sentences.ts';
import type { ParsedSentence } from './sentences.ts';
import type { ServerPayload } from '../shared/protocol.ts';

export class TurnError extends Error {
  code: string;
  fallbackText?: string;
  constructor(message: string, code: string, fallbackText?: string) { super(message); this.code = code; this.fallbackText = fallbackText; }
}
export function recording(value: unknown, maxSeconds: number): Buffer {
  if (!value || typeof value !== 'object') throw new TurnError('录音格式不正确，请重新录制。', 'invalid_audio');
  const audio = value as { format?: string; data?: unknown };
  if (audio.format !== 'wav' || typeof audio.data !== 'string' || audio.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio.data)) throw new TurnError('录音格式不正确，请重新录制。', 'invalid_audio');
  const wav = Buffer.from(audio.data, 'base64');
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE' || wav.toString('ascii', 12, 16) !== 'fmt ' || wav.toString('ascii', 36, 40) !== 'data') throw new TurnError('录音不是有效的 WAV，请重新录制。', 'invalid_audio');
  const rate = wav.readUInt32LE(24); const bytes = wav.readUInt32LE(40);
  if (wav.readUInt32LE(16) !== 16 || wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1 || wav.readUInt16LE(32) !== 2 || wav.readUInt16LE(34) !== 16 || wav.readUInt32LE(28) !== rate * 2 || rate < 8000 || rate > 48000 || bytes % 2 || bytes !== wav.length - 44 || wav.readUInt32LE(4) !== wav.length - 8) throw new TurnError('录音编码不受支持，请重新录制。', 'invalid_audio');
  const seconds = bytes / (rate * 2);
  if (seconds < 0.15) throw new TurnError('录音太短，请再说一次。', 'empty_audio');
  if (seconds > maxSeconds + 0.1) throw new TurnError('录音超过时长限制，请缩短后再试。', 'audio_too_long');
  let peak = 0; for (let offset = 44; offset < wav.length; offset += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(offset)));
  if (peak < 115) throw new TurnError('没有听到有效声音，请再说一次。', 'empty_audio');
  return wav;
}

export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); throw signal.reason ?? new DOMException('Aborted', 'AbortError'); }
  let listener: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    listener = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([promise, stopped]); }
  finally { signal.removeEventListener('abort', listener); }
}

export async function runTurn(options: {
  turnId: string; audio: Buffer; cloud: CloudAdapters; signal: AbortSignal;
  messages: ChatMessage[]; emotions: string[]; send(payload: ServerPayload): void;
  onQuestion(text: string): void;
  reply?(messages: ChatMessage[], signal: AbortSignal, timings: Record<string, number>): AsyncIterable<string>;
  timings?: Record<string, number>;
}) {
  const { turnId, audio, cloud, signal, send } = options;
  const started = performance.now(); const timings = options.timings ?? {};
  send({ type: 'turn.state', turnId, state: 'recognizing' });
  const question = (await abortable(cloud.transcribe(audio, signal), signal)).trim();
  if (!question) throw new TurnError('没有听清这段话，请再说一次。', 'empty_transcript');
  timings.asrMs = performance.now() - started;
  options.onQuestion(question); send({ type: 'transcript', turnId, text: question });
  send({ type: 'turn.state', turnId, state: 'thinking' });
  let firstText = false; let answer = ''; let sequence = 0;
  const parser = new SentenceStream(options.emotions, () => { if (!firstText) { firstText = true; timings.firstTextMs = performance.now() - started; } });
  const speak = async (sentence: ParsedSentence) => {
    signal.throwIfAborted(); answer += sentence.text;
    if ((answer.match(/[。！？!?]+/g)?.length ?? 0) > 3 || answer.length > 2000) throw new TurnError('这次回答有些长，请换个简短问题再试。', 'invalid_reply');
    send({ type: 'turn.state', turnId, state: 'synthesizing' });
    const ttsStart = performance.now();
    let speech;
    try { speech = await abortable(cloud.synthesize({ text: sentence.text, style: sentence.style }, signal), signal); }
    catch (error) {
      if (signal.aborted) throw error;
      throw new TurnError('声音暂时没有生成成功，可以先看这段文字，再重新说一次。', 'tts_failed', answer);
    }
    signal.throwIfAborted(); timings.ttsMs = (timings.ttsMs ?? 0) + performance.now() - ttsStart;
    if (timings.firstAudioReadyMs === undefined) timings.firstAudioReadyMs = performance.now() - started;
    const segmentId = turnId + ':' + sequence;
    send({ type: 'speech.segment', turnId, sequence, segmentId, ...sentence });
    send({ type: 'speech.audio', turnId, sequence, segmentId, data: speech.data.toString('base64'), mimeType: speech.mimeType, final: true });
    sequence++;
  };
  const messages: ChatMessage[] = [...options.messages, { role: 'user', content: question }];
  const iterator = (options.reply ? options.reply(messages, signal, timings) : cloud.streamReply(messages, signal))[Symbol.asyncIterator]();
  try {
    while (true) {
      const modelWaitStarted = performance.now();
      const next = await abortable(iterator.next(), signal);
      timings.modelReadWaitMs = (timings.modelReadWaitMs ?? 0) + performance.now() - modelWaitStarted;
      if (next.done) break;
      for (const sentence of parser.push(next.value)) await speak(sentence);
    }
    for (const sentence of parser.finish()) await speak(sentence);
    if (!answer.trim()) throw new TurnError('没有生成有效回答，请再说一次。', 'empty_reply');
    timings.totalServerMs = performance.now() - started;
    return { answer, timings };
  } finally { void Promise.resolve(iterator.return?.()).catch(() => {}); }
}
