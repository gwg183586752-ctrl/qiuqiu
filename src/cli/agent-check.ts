import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { join, resolve } from 'node:path';
import { readConfig } from '../server/config.ts';
import { createSdkBrain } from '../server/cloud/sdk.ts';
import { serverTime, timeInputSchema, TIME_TOOL } from '../server/tools.ts';
import { baselinePrompt } from '../server/prompt.ts';
import { EMOTIONS } from '../shared/protocol.ts';
import type { ToolExchange } from '../server/cloud/types.ts';
import { redactor } from '../server/audit.ts';

async function main() {
  if (existsSync('.env')) loadEnvFile('.env');
  if (!process.argv.includes('--real')) throw new Error('explicit-real-required');
  const config = readConfig({ ...process.env, CLOUD_MODE: 'real' });
  if (new URL(config.mimoBaseUrl).hostname !== 'api.xiaomimimo.com') throw new Error('official-endpoint-required');
  const directory = resolve('.cache/sdk-spike-' + Date.now()); mkdirSync(directory, { recursive: true });
  const events: Record<string, unknown>[] = [];
  const sdk = createSdkBrain(config, { thinking: process.argv.includes('--thinking'), observe: event => events.push(event) });
  const signal = AbortSignal.any([AbortSignal.timeout(config.turnTimeoutMs), ...(process.argv.includes('--cancel') ? [AbortSignal.timeout(250)] : [])]); const started = performance.now();
  const question = process.argv.includes('--multi') ? '请在同一个响应中发起四次 get_server_time 工具调用，前两次查询 Asia/Shanghai，后两次查询 UTC。取得结果后用一句话概括时间。' : '请立即调用 get_server_time 查询服务器当前北京时间，精确到秒。';
  const messages = [{ role: 'system' as const, content: '这是工具协议诊断。你有 get_server_time 工具，必须实际调用它查询当前时间，不要猜测、不拒绝查询。获得工具结果后，用一句中文回答北京时间，精确到秒。' }, { role: 'user' as const, content: question }];
  const report: Record<string, unknown> = { directory, evidence: 'real-sdk-real-mimo', versions: { ai: '6.0.315', provider: '2.0.87' }, model: config.chatModel, thinking: process.argv.includes('--thinking') };
  try {
    const decisionStart = performance.now(); const decision = await sdk.decideTools!(messages, [], signal);
    report.decisionMs = performance.now() - decisionStart; report.discardedTextChars = decision.discardedTextChars; report.reasoningChars = decision.reasoning?.length ?? 0;
    if (!decision.calls.length) throw new Error('real-model-did-not-call-tool');
    const exchange: ToolExchange = { calls: decision.calls, reasoning: decision.reasoning, results: [] };
    let attempts = 0;
    for (const call of decision.calls) {
      const parsed = timeInputSchema.safeParse(call.input);
      if (call.name !== TIME_TOOL.name || !parsed.success || attempts >= 3) { exchange.results.push({ id: call.id, name: call.name, value: { error: 'rejected' } }); continue; }
      attempts++; const toolStart = performance.now(); const value = await serverTime(parsed.data.timeZone, signal);
      exchange.results.push({ id: call.id, name: call.name, value }); report.toolMs = performance.now() - toolStart;
    }
    report.actualAttempts = attempts; report.results = exchange.results;
    let answer = ''; const finalStart = performance.now();
    for await (const chunk of sdk.streamFinal!(messages, [exchange], signal)) { if (!answer) report.firstFinalTextMs = performance.now() - started; answer += chunk; }
    Object.assign(report, { success: true, answer, finalMs: performance.now() - finalStart, totalMs: performance.now() - started });
  } catch { report.success = false; report.reason = signal.aborted ? 'cancelled_or_timeout' : 'sdk_or_provider_contract_not_completed'; report.elapsedMs = performance.now() - started; report.expectedCancellation = process.argv.includes('--cancel') && signal.aborted; if (!report.expectedCancellation) process.exitCode = 1; }
  const safe = redactor([config.mimoApiKey, config.accessToken]);
  writeFileSync(join(directory, 'report.json'), safe(JSON.stringify({ ...report, events }, null, 2)));
  console.log(safe(JSON.stringify(report, null, 2)));
}
main().catch(() => { console.error('SDK真实诊断未完成：请使用 --real 并检查本机配置，报告不会输出凭证。'); process.exitCode = 1; });
