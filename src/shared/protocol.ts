export const PROTOCOL_VERSION = 1 as const;
export const GREETING = '嗨，我是小糖，今天想聊点什么呀？';
export const EMOTIONS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'] as const;
export const ACTIONS = ['nod', 'shake', 'tilt', 'lean'] as const;
export type Emotion = typeof EMOTIONS[number];
export type Action = typeof ACTIONS[number];
export type TurnState = 'recognizing' | 'thinking' | 'querying' | 'synthesizing';

export interface Segment {
  sequence: number;
  segmentId: string;
  text: string;
  emotion?: Emotion;
  action?: Action;
  style?: string;
}
export interface Envelope { version: 1; sessionId: string; connectionEpoch: number }
export type ServerPayload =
  | { type: 'session.ready'; isNew: boolean; mode: 'fake' | 'real'; maxRecordingSeconds: number }
  | { type: 'session.replaced'; message: string }
  | { type: 'turn.state'; turnId: string; state: TurnState }
  | { type: 'transcript'; turnId: string; text: string }
  | ({ type: 'speech.segment'; turnId: string } & Segment)
  | { type: 'speech.audio'; turnId: string; sequence: number; segmentId: string; data: string; mimeType: 'audio/wav'; final: true }
  | { type: 'turn.done'; turnId: string; answer: string; greeting?: boolean; timings?: Record<string, number> }
  | { type: 'turn.error'; turnId?: string; code: string; message: string; fallbackText?: string };
export type ServerEvent = Envelope & ServerPayload;
export type ClientEvent =
  | { type: 'hello'; version: 1; expressions: string[] }
  | { type: 'turn.submit'; version: 1; turnId: string; audio: { format: 'wav'; data: string } }
  | { type: 'playback.done'; version: 1; turnId: string }
  | { type: 'metric'; version: 1; turnId: string; firstAudioMs: number };

export interface ClientConfig { accessToken: string; mode: 'fake' | 'real'; maxRecordingSeconds: number }
