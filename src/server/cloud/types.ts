export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export interface SpeechInput { text: string; style?: string }
export interface AudioResult { data: Buffer; mimeType: 'audio/wav'; sampleRate: number }
export interface ToolCall { id: string; name: string; input: unknown }
export interface ToolResult { id: string; name: string; value: Record<string, string | number | boolean | null> }
export interface ToolExchange { calls: ToolCall[]; results: ToolResult[]; reasoning?: string }
export interface ToolDecision { calls: ToolCall[]; reasoning?: string; discardedTextChars?: number }
export interface CloudAdapters {
  readonly mode: 'fake' | 'real';
  transcribe(wav: Buffer, signal: AbortSignal): Promise<string>;
  streamReply(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  synthesize(input: SpeechInput, signal: AbortSignal): Promise<AudioResult>;
  decideTools?(messages: ChatMessage[], exchanges: ToolExchange[], signal: AbortSignal): Promise<ToolDecision>;
  streamFinal?(messages: ChatMessage[], exchanges: ToolExchange[], signal: AbortSignal): AsyncIterable<string>;
}
export class CloudError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(message: string, code: string, status?: number) {
    super(message); this.name = 'CloudError'; this.code = code; this.status = status;
  }
}
