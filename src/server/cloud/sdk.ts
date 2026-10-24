import { streamText, tool } from 'ai';
import type { ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { AppConfig } from '../config.ts';
import { TIME_TOOL, timeInputSchema } from '../tools.ts';
import { CloudError } from './types.ts';
import type { ChatMessage, CloudAdapters, ToolCall, ToolExchange } from './types.ts';

function modelMessages(messages: ChatMessage[], exchanges: ToolExchange[]): ModelMessage[] {
  const output: ModelMessage[] = [...messages];
  for (const exchange of exchanges) {
    if (!exchange.calls.length) continue;
    output.push({ role: 'assistant', content: [
      ...(exchange.reasoning ? [{ type: 'reasoning' as const, text: exchange.reasoning }] : []),
      ...exchange.calls.map(call => ({ type: 'tool-call' as const, toolCallId: call.id, toolName: call.name, input: call.input })),
    ] });
    output.push({ role: 'tool', content: exchange.results.map(result => ({ type: 'tool-result' as const, toolCallId: result.id, toolName: result.name, output: { type: 'json' as const, value: result.value } })) });
  }
  return output;
}

export function createSdkBrain(config: AppConfig, options: { thinking?: boolean; observe?: (event: Record<string, unknown>) => void } = {}): Pick<CloudAdapters, 'decideTools' | 'streamFinal'> {
  const provider = createOpenAICompatible({
    name: 'mimo', baseURL: config.mimoBaseUrl, headers: { 'api-key': config.mimoApiKey }, includeUsage: false,
    transformRequestBody: body => {
      const { max_tokens, ...rest } = body;
      return { ...rest, max_completion_tokens: max_tokens ?? 512, thinking: { type: options.thinking ? 'enabled' : 'disabled' } };
    },
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body));
      options.observe?.({ event: 'request', model: body.model, tools: body.tools?.map((value: { function: { name: string } }) => value.function.name) ?? [], toolsFieldPresent: Object.hasOwn(body, 'tools'), toolChoice: body.tool_choice, thinking: body.thinking, toolResultMessages: body.messages?.filter((message: { role: string }) => message.role === 'tool').length, reasoningHistoryMessages: body.messages?.filter((message: { reasoning_content?: string }) => !!message.reasoning_content).length });
      return fetch(url, { ...init, redirect: 'error' });
    },
  });
  const model = provider.chatModel(config.chatModel);
  const tools = { [TIME_TOOL.name]: tool({ description: TIME_TOOL.description, inputSchema: timeInputSchema }) };
  return {
    async decideTools(messages, exchanges, signal) {
      const response = streamText({ model, messages: modelMessages(messages, exchanges), allowSystemInMessages: true, tools, toolChoice: 'auto', maxOutputTokens: options.thinking ? 2048 : 512, maxRetries: 0, abortSignal: signal });
      const calls: ToolCall[] = []; let reasoning = ''; let discardedTextChars = 0;
      for await (const part of response.fullStream) {
        signal.throwIfAborted();
        options.observe?.({ event: 'stream-part', type: part.type, text: part.type === 'text-delta' ? part.text : undefined });
        if (part.type === 'error') throw new CloudError('工具判定生成未完成，请稍后再试。', 'agent_model_failed');
        if (part.type === 'tool-call') calls.push({ id: part.toolCallId, name: part.toolName, input: part.input });
        if (part.type === 'reasoning-delta') reasoning += part.text;
        if (part.type === 'text-delta') discardedTextChars += part.text.length;
      }
      signal.throwIfAborted();
      const finish = await response.finishReason;
      if (!['stop', 'tool-calls'].includes(finish)) throw new CloudError('工具判定没有完整结束。', 'agent_incomplete');
      return { calls, reasoning: reasoning || undefined, discardedTextChars };
    },
    async *streamFinal(messages, exchanges, signal) {
      // 此请求完全省略 tools；MiMo 不能仅依赖 tool_choice:none 关闭工具。
      const response = streamText({ model, messages: modelMessages(messages, exchanges), allowSystemInMessages: true, maxOutputTokens: 512, maxRetries: 0, abortSignal: signal });
      for await (const part of response.fullStream) {
        signal.throwIfAborted();
        if (part.type === 'error') throw new CloudError('最终回答生成未完成，请稍后再试。', 'agent_final_failed');
        if (part.type === 'text-delta') yield part.text;
      }
      signal.throwIfAborted();
      if (await response.finishReason !== 'stop') throw new CloudError('最终回答没有完整结束。', 'agent_incomplete');
    },
  };
}
