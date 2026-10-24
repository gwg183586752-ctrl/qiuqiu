import type { CloudAdapters } from './types.ts';
import { simulatedWav } from './audio.ts';
import { TIME_TOOL } from '../tools.ts';

export function createFakeCloud(): CloudAdapters {
  const adapter: CloudAdapters = {
    mode: 'fake',
    async transcribe(_wav, signal) { signal.throwIfAborted(); return '你好，小糖。'; },
    async *streamReply(messages, signal) {
      const followUp = messages.filter(message => message.role === 'assistant').length % 2 === 1;
      const chunks = followUp
        ? ['<emo:happy><act:tilt>(开心)讲到喜欢的球队就有好多故事。', '<emo:relaxed><act:lean>我在认真听，你接着说呀。']
        : ['<emo:happy><act:nod>(开心)你好呀，很高兴和你聊足球！', '<emo:relaxed><act:shake>今天想聊哪支球队？'];
      for (const text of chunks) {
        signal.throwIfAborted(); yield text;
      }
    },
    async synthesize(_input, signal) {
      signal.throwIfAborted();
      return { data: simulatedWav(), mimeType: 'audio/wav', sampleRate: 24000 };
    },
  };
  adapter.decideTools = async (messages, exchanges, signal) => {
    signal.throwIfAborted();
    return { calls: !exchanges.length && /几点|时间/.test(messages.at(-1)?.content ?? '') ? [{ id: 'simulated-time-call', name: TIME_TOOL.name, input: { timeZone: 'Asia/Shanghai' } }] : [] };
  };
  adapter.streamFinal = async function* (messages, exchanges, signal) {
    if (exchanges.length) { signal.throwIfAborted(); yield '<emo:happy>本机时间是' + (exchanges[0].results[0]?.value.localTime ?? '暂时查询不到') + '。'; }
    else yield* adapter.streamReply(messages.filter(message => !message.content.startsWith('现在进入最终回答阶段')), signal);
  };
  return adapter;
}
