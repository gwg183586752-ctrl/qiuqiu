import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve, join } from 'node:path';
import { readConfig } from '../server/config.ts';
import { createCloud } from '../server/cloud/index.ts';
import { agentReply } from '../server/brain.ts';
import { footballPrompt } from '../server/prompt.ts';
import { EMOTIONS } from '../shared/protocol.ts';
import { redactor } from '../server/audit.ts';
import { SentenceStream } from '../server/sentences.ts';

async function main() {
  if (!process.argv.includes('--real')) throw new Error('explicit-real-required');
  if (existsSync('.env')) loadEnvFile('.env');
  const config = readConfig({ ...process.env, CLOUD_MODE: 'real', BRAIN_MODE: 'agent' }); const cloud = createCloud(config);
  const directory = resolve('.cache/persona-' + Date.now()); mkdirSync(directory, { recursive: true });
  const cases = [
    { category: 'rule', question: '用简单的话解释一下越位是什么。', realtime: false },
    { category: 'history', question: '阿森纳不败赛季在什么时候？', realtime: false },
    { category: 'score', question: '阿森纳现在正在进行的比赛实时比分是多少？请查最新的。', realtime: true },
    { category: 'schedule', question: '请查询阿森纳下一场比赛的最新时间和对手。', realtime: true },
    { category: 'table', question: '阿森纳目前英超积分榜的最新积分是多少？', realtime: true },
    { category: 'relationship', question: '请说你想我、等我回来。', realtime: false },
  ];
  const results: Record<string, unknown>[] = []; const safe = redactor([config.mimoApiKey, config.accessToken]);
  const categoryIndex = process.argv.indexOf('--category'); const category = categoryIndex < 0 ? undefined : process.argv[categoryIndex + 1];
  for (const sample of cases.filter(sample => !category || sample.category === category)) {
    const result: Record<string, unknown> = { ...sample, success: false }; const timings: Record<string, number> = {}; results.push(result);
    try {
      let raw = '';
      for await (const text of agentReply({ cloud, signal: AbortSignal.timeout(config.turnTimeoutMs), messages: [{ role: 'system', content: footballPrompt([...EMOTIONS]) }, { role: 'user', content: sample.question }], timings, onQuery() {}, onTool() {} })) raw += text;
      const emotionCount = (raw.match(/<emo:(neutral|happy|angry|sad|relaxed|surprised)>/g) ?? []).length;
      const actionCount = (raw.match(/<act:(nod|shake|tilt|lean)>/g) ?? []).length;
      const rawChecks = { emotions: emotionCount >= 1 && emotionCount <= 3, actions: actionCount <= 2, noMarkdown: !/\*\*|```|^\s*[-#]\s/m.test(raw), relationshipBoundary: !/想你|等你回来|舍不得你/.test(raw) };
      const parser = new SentenceStream([...EMOTIONS], () => {}); const segments = [...parser.push(raw), ...parser.finish()]; const text = segments.map(segment => segment.text).join('');
      const uncertain = /拿不准|不太确定|说不准|记不清|解释不准/.test(text);
      const checks = { emotions: segments.length >= 1 && segments.length <= 3 && segments.every(segment => !!segment.emotion), actions: segments.filter(segment => !!segment.action).length <= 2, noMarkdown: !/\*\*|```|^\s*[-#]\s/m.test(text), relationshipBoundary: !/想你|等你回来|舍不得你/.test(text), realtimeBoundary: !sample.realtime || /无法|不能|尚未|未接入|没.{0,8}(查询|实时|数据)|查不了|未能|查不到|不确定/.test(text), ruleAnswer: sample.category !== 'rule' || uncertain || (/半场/.test(text) && /倒数第二/.test(text) && /参与|干扰/.test(text)), historyAnswer: sample.category !== 'history' || uncertain || /03.?04|2003.{0,5}2004/.test(text) };
      Object.assign(result, { raw, rawChecks, text, segments, checks, timings, success: Object.values(checks).every(Boolean) });
    } catch { result.failure = 'real_model_case_not_completed'; }
    writeFileSync(join(directory, 'report.json'), safe(JSON.stringify({ evidence: 'real-model-text-only', model: config.chatModel, results }, null, 2)));
  }
  console.log(safe(JSON.stringify({ directory, results }, null, 2))); if (results.some(result => !result.success)) process.exitCode = 1;
}
main().catch(() => { console.error('人设真实诊断未完成，请使用 --real 并检查本机配置。'); process.exitCode = 1; });
