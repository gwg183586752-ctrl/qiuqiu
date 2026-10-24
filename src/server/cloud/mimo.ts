import type { AppConfig } from '../config.ts';
import { CloudError } from './types.ts';
import type { CloudAdapters } from './types.ts';
import { pcmToWav } from './audio.ts';
import { createSdkBrain } from './sdk.ts';

type CompletionChunk = {
  error?: unknown;
  choices?: { delta?: { content?: string; audio?: { data?: string } }; finish_reason?: string | null }[];
};

async function request(config: AppConfig, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(config.mimoBaseUrl + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': config.mimoApiKey },
      redirect: 'error',
      body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(config.turnTimeoutMs)]),
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof Error && error.name === 'TimeoutError') throw new CloudError('云服务等待超时，请稍后再试。', 'cloud_timeout');
    throw new CloudError('暂时无法连接语音服务，请稍后再试。', 'cloud_network');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new CloudError(response.status === 401 || response.status === 403 ? '云接口认证或模型权限不可用，请检查本机配置。' : '云接口暂时不可用，请稍后再试。', 'cloud_http', response.status);
  }
  return response;
}

async function* events(response: Response): AsyncGenerator<CompletionChunk> {
  if (!response.body) throw new CloudError('云接口没有返回数据。', 'empty_stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let terminal = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary: RegExpMatchArray | null;
      while ((boundary = pending.match(/\r?\n\r?\n/))) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index! + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        if (data === '[DONE]') { terminal = true; return; }
        let chunk: CompletionChunk;
        try { chunk = JSON.parse(data); } catch { throw new CloudError('云接口返回了无法解析的数据。', 'invalid_stream'); }
        if (chunk.error) throw new CloudError('云接口中断了本轮生成。', 'stream_error');
        const finish = chunk.choices?.[0]?.finish_reason;
        if (finish && finish !== 'stop') throw new CloudError('本轮生成未完整结束，请重新说一次。', 'incomplete_generation');
        if (finish === 'stop') terminal = true;
        yield chunk;
      }
      if (done) break;
      if (pending.length > 8_000_000) throw new CloudError('云接口返回的数据过大。', 'stream_too_large');
    }
    if (!terminal) throw new CloudError('本轮生成连接提前结束，请重新说一次。', 'truncated_stream');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createMimoCloud(config: AppConfig): CloudAdapters {
  return {
    ...createSdkBrain(config),
    mode: 'real',
    async transcribe(wav, signal) {
      const response = await request(config, {
        model: config.asrModel, stream: false, asr_options: { language: 'zh' },
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } }] }],
      }, signal);
      const result = await response.json() as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
      const choice = result.choices?.[0];
      if (choice?.finish_reason && choice.finish_reason !== 'stop') throw new CloudError('语音识别未完整结束。', 'incomplete_asr');
      const text = choice?.message?.content?.trim();
      if (!text) throw new CloudError('没有听清这段话，请再说一次。', 'empty_transcript');
      return text;
    },
    async *streamReply(messages, signal) {
      const response = await request(config, { model: config.chatModel, messages, stream: true, thinking: { type: 'disabled' }, max_completion_tokens: 512 }, signal);
      for await (const chunk of events(response)) {
        signal.throwIfAborted();
        const text = chunk.choices?.[0]?.delta?.content;
        if (text) yield text;
      }
    },
    async synthesize(input, signal) {
      const response = await request(config, {
        model: config.ttsModel, stream: true, audio: { format: 'pcm16', voice: config.voice },
        messages: [
          { role: 'user', content: input.style || '用明亮、温暖、自然的中文短句说话。' },
          { role: 'assistant', content: input.text },
        ],
      }, signal);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of events(response)) {
        signal.throwIfAborted();
        const data = chunk.choices?.[0]?.delta?.audio?.data;
        if (data) {
          const decoded = Buffer.from(data, 'base64'); bytes += decoded.length;
          if (bytes > 5_760_000) throw new CloudError('合成音频超过本机限制。', 'audio_too_large');
          chunks.push(decoded);
        }
      }
      if (!bytes || bytes % 2) throw new CloudError('没有获得完整的合成声音，请稍后再试。', 'empty_audio');
      return { data: pcmToWav(Buffer.concat(chunks), 24000), mimeType: 'audio/wav', sampleRate: 24000 };
    },
  };
}
