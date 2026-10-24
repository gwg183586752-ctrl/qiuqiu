import type { ChatMessage, CloudAdapters, ToolExchange } from './cloud/types.ts';
import { CloudError } from './cloud/types.ts';
import { abortable } from './pipeline.ts';
import { serverTime, timeInputSchema, TIME_TOOL } from './tools.ts';
import type { TimeProbe } from './tools.ts';

export interface ToolObservation {
  ordinal: number; name: string; executed: boolean; status: string; input: unknown;
  result: Record<string, string | number | boolean | null>; durationMs: number;
}

export async function* agentReply(options: {
  cloud: CloudAdapters; messages: ChatMessage[]; signal: AbortSignal; timings: Record<string, number>;
  onQuery(): void; onTool(observation: ToolObservation): void; timeProbe?: TimeProbe;
}) {
  const { cloud, signal, messages, timings } = options;
  if (!cloud.decideTools || !cloud.streamFinal) throw new CloudError('Agent 云适配器尚未就绪。', 'agent_unavailable');
  const exchanges: ToolExchange[] = []; let attempts = 0; let ordinal = 0;
  const needsCurrentTime = /(现在|此刻|当前)(的)?(北京|服务器|UTC|当地)?时间|(?:现在|当前).{0,8}几点|服务器(?:当前|现在)?(?:时间|几点)|几点了|what time is it|current (server )?time/i.test(messages.at(-1)?.content ?? '');
  options.onQuery();
  // 生成步骤与执行配额分别计数；非法请求也只能纠正有限轮，最终回答另占一次请求。
  for (let decisionIndex = 0; decisionIndex < 3 && attempts < 3; decisionIndex++) {
    signal.throwIfAborted(); const decisionStart = performance.now();
    const correction = needsCurrentTime && decisionIndex > 0 && !attempts ? '上一轮没有实际调用工具，仍未得到当前时间。请实际发起 get_server_time 调用，不能只说明会查询。' : '';
    const decisionMessages: ChatMessage[] = [{ role: 'system', content: `你是内部工具选择器。唯一可用工具 ${TIME_TOOL.name}：${TIME_TOOL.description} 用户询问现在几点、北京时间或服务器当前时间时，必须调用此工具，不能猜测或只表示明白。普通闲聊、基础足球知识不需要工具。不得调用其他工具，不要写演出标签，不回答用户事实问题；无需工具时只说无需工具。${correction}` }, ...messages.filter(message => message.role !== 'system')];
    const decision = await abortable(cloud.decideTools(decisionMessages, exchanges, signal), signal);
    timings.toolModelMs = (timings.toolModelMs ?? 0) + performance.now() - decisionStart;
    timings.discardedToolTextChars = (timings.discardedToolTextChars ?? 0) + (decision.discardedTextChars ?? 0);
    signal.throwIfAborted();
    if (!decision.calls.length) {
      if (needsCurrentTime && attempts === 0 && decisionIndex < 2) { timings.noToolDecisionRetries = (timings.noToolDecisionRetries ?? 0) + 1; continue; }
      break;
    }
    const exchange: ToolExchange = { calls: decision.calls, results: [], reasoning: decision.reasoning };
    for (const call of decision.calls) {
      signal.throwIfAborted(); const started = performance.now();
      const parsed = timeInputSchema.safeParse(call.input);
      let executed = false; let status: string; let result: ToolObservation['result'];
      if (attempts >= 3) { status = 'rejected_quota'; result = { error: 'quota_exhausted' }; }
      else if (call.name !== TIME_TOOL.name || !parsed.success) { status = 'rejected_validation'; result = { error: 'invalid_tool_or_arguments' }; }
      else {
        attempts++; executed = true;
        try { result = await abortable((options.timeProbe ?? serverTime)(parsed.data.timeZone, signal), signal); signal.throwIfAborted(); status = 'succeeded'; }
        catch (error) {
          if (signal.aborted) {
            options.onTool({ ordinal: ++ordinal, name: call.name, executed, status: 'cancelled', input: call.input, result: { error: 'cancelled_or_timeout' }, durationMs: performance.now() - started });
            throw error;
          }
          status = 'failed'; result = { error: 'tool_failed' };
        }
      }
      const durationMs = performance.now() - started;
      if (executed) timings.toolMs = (timings.toolMs ?? 0) + durationMs;
      options.onTool({ ordinal: ++ordinal, name: call.name, executed, status, input: call.input, result, durationMs });
      exchange.results.push({ id: call.id, name: call.name, value: result });
    }
    exchanges.push(exchange);
    // M0 只有幂等时间探针，已获得有效时间即可收尾，无需再请求一次模型确认。
    if (exchange.results.some(result => typeof result.value.iso === 'string' && !result.value.error)) break;
  }
  signal.throwIfAborted(); timings.actualToolAttempts = attempts;
  const finalRule = '\n现在进入最终回答阶段，不再调用工具。直接回答用户最后一个问题本身，不要只说明白、承诺稍后解释或让用户看图。本产品没有展示图片和打开网页的功能。只依据本次真实工具结果和已知背景回答；没有取得时间结果时必须明确说未能查询，不能报当前时间。若工具失败或信息不足，简短说明拿不准，不编造时间、实时数据或查询来源。仍遵守小糖的六条演出规则。';
  const ruleReminder = /越位/.test(messages.at(-1)?.content ?? '') ? '\n本题解释越位，请先说清“在对方半场”这个适用范围，再说明比球和倒数第二名对手更近对方球门线的位置条件，以及仅站位不犯规、参与进攻才可能犯规。拿不准就直接说拿不准。' : '';
  const finalMessages: ChatMessage[] = messages.map(message => message.role === 'system' ? { ...message, content: message.content + finalRule + ruleReminder } : message);
  const finalStart = performance.now();
  try { for await (const text of cloud.streamFinal(finalMessages, exchanges, signal)) { signal.throwIfAborted(); yield text; } }
  finally { timings.finalStreamWallMs = performance.now() - finalStart; }
}
