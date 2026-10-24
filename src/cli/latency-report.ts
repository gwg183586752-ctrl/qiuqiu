import { readFileSync, writeFileSync } from 'node:fs';

type Sample = { category: string; warmup: boolean; success: boolean; firstAudioMs?: number; timings?: Record<string, number> };
type Batch = { brain: string; sourceSha256: string; models: unknown; audio: unknown; samples: Sample[]; invalidatedReason?: string };
function argument(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
function metric(values: number[]) {
  values.sort((a, b) => a - b); const n = values.length;
  if (!n) return { n: 0, medianMs: null, p95Ms: null, maxMs: null };
  return { n, medianMs: n % 2 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2, p95Ms: values[Math.ceil(n * .95) - 1], maxMs: values[n - 1] };
}
function summarize(batch: Batch) {
  const measured = batch.samples.filter(sample => !sample.warmup); const categories = [...new Set(measured.map(sample => sample.category))];
  return Object.fromEntries(categories.map(category => {
    const all = measured.filter(sample => sample.category === category); const successes = all.filter(sample => sample.success);
    const values = (key: string) => successes.map(sample => key === 'firstAudioMs' ? sample.firstAudioMs : sample.timings?.[key]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return [category, { total: all.length, successful: successes.length, failed: all.length - successes.length, failureRate: (all.length - successes.length) / all.length, metrics: Object.fromEntries(['firstTextMs', 'firstAudioReadyMs', 'firstAudioMs', 'asrMs', 'toolModelMs', 'toolMs', 'ttsMs', 'modelReadWaitMs', 'totalServerMs'].map(key => [key, metric(values(key))])) }];
  }));
}
try {
  const baselinePath = argument('--baseline'); if (!baselinePath) throw new Error('arguments');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8').replace(/^\uFEFF/, '')) as Batch;
  const agentPath = argument('--agent'); const agent = agentPath ? JSON.parse(readFileSync(agentPath, 'utf8').replace(/^\uFEFF/, '')) as Batch : undefined;
  const baselineSummary = summarize(baseline); const agentSummary = agent ? summarize(agent) : undefined;
  const sameConditions = agent ? !baseline.invalidatedReason && !agent.invalidatedReason && baseline.sourceSha256 === agent.sourceSha256 && JSON.stringify(baseline.models) === JSON.stringify(agent.models) && JSON.stringify(baseline.audio) === JSON.stringify(agent.audio) && JSON.stringify(baseline.samples.map(s => [s.category, (s as Sample & { audioSha256?: string }).audioSha256])) === JSON.stringify(agent.samples.map(s => [s.category, (s as Sample & { audioSha256?: string }).audioSha256])) : undefined;
  const comparison = agentSummary ? Object.fromEntries(Object.keys(baselineSummary).map(category => [category, Object.fromEntries(['firstTextMs', 'firstAudioReadyMs', 'firstAudioMs'].map(key => {
    const before = baselineSummary[category].metrics[key].medianMs; const after = agentSummary[category]?.metrics[key].medianMs;
    return [key, { deltaMedianMs: typeof before === 'number' && typeof after === 'number' ? after - before : null, within500ms: typeof before === 'number' && typeof after === 'number' && sameConditions ? after - before <= 500 : null }];
  }))])) : undefined;
  const report = { smallSampleWarning: '每类仅三轮正式样本；p95是最近秩统计，通常等于最大值，不能推断长期服务分位数。失败样本保留并计入失败率。', sameConditions, baseline: baselineSummary, agent: agentSummary, comparison };
  if (argument('--output')) writeFileSync(argument('--output')!, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch { console.error('用法：latency-report --baseline <samples.json> [--agent <samples.json>] [--output <report.json>]'); process.exitCode = 1; }
