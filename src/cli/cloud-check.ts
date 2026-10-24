import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { readConfig, ConfigError } from '../server/config.ts';
import { createCloud } from '../server/cloud/index.ts';
import { simulatedWav } from '../server/cloud/audio.ts';
import { CloudError } from '../server/cloud/types.ts';
import { runTurn, recording, TurnError } from '../server/pipeline.ts';
import { baselinePrompt } from '../server/prompt.ts';
import { footballPrompt } from '../server/prompt.ts';
import { agentReply } from '../server/brain.ts';
import type { ToolObservation } from '../server/brain.ts';
import { EMOTIONS } from '../shared/protocol.ts';

function argument(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }

async function main() {
  if (existsSync('.env')) loadEnvFile('.env');
  if (process.argv.includes('--fake')) process.env.CLOUD_MODE = 'fake';
  if (process.argv.includes('--real')) process.env.CLOUD_MODE = 'real';
  if (process.argv.includes('--agent')) process.env.BRAIN_MODE = 'agent';
  const config = readConfig();
  const cloud = createCloud(config);
  if (cloud.mode === 'real') {
    if (!process.argv.includes('--real') || (!argument('--audio') && !process.argv.includes('--speech-fixture'))) throw new Error('真实验证需要 --real 加 --audio <WAV文件> 或 --speech-fixture。');
    if (new URL(config.mimoBaseUrl).hostname !== 'api.xiaomimimo.com') throw new Error('本次真实验证仅访问已确认的 MiMo 官方接口。');
    const directory = resolve(argument('--directory') ?? '.cache/real-cloud-' + Date.now());
    mkdirSync(directory, { recursive: true });
    const report: Record<string, unknown> = {
      mode: 'real', evidence: 'real-cloud',
      inputSource: argument('--audio') ? 'provided-wav' : 'real-tts-speech-fixture',
      directory,
      models: { chat: config.chatModel, asr: config.asrModel, tts: config.ttsModel, voice: config.voice },
      brainMode: config.brainMode,
      startedAt: new Date().toISOString(),
    };
    const safe = (value: unknown) => JSON.stringify(value, null, 2).replaceAll(config.mimoApiKey, '<REDACTED>');
    let stage = 'prepare-input';
    const deadline = AbortSignal.timeout(config.turnTimeoutMs);
    try {
      let wav: Buffer;
      if (argument('--audio')) wav = readFileSync(resolve(argument('--audio')!));
      else {
        stage = 'synthesize-input';
        const started = performance.now();
        const fixture = await cloud.synthesize({ text: argument('--text') ?? '我喜欢阿森纳，请陪我聊聊足球。', style: '用自然清晰的中文说话。' }, deadline);
        wav = fixture.data; writeFileSync(join(directory, 'input.wav'), wav);
        report.inputTtsMs = performance.now() - started;
        report.inputAudioBytes = wav.length;
        report.inputDurationSeconds = (wav.length - 44) / (fixture.sampleRate * 2);
      }
      recording({ format: 'wav', data: wav.toString('base64') }, config.maxRecordingSeconds);
      stage = 'asr-chat-tts';
      const segments: Record<string, unknown>[] = [];
      const tools: ToolObservation[] = [];
      const result = await runTurn({
        turnId: 'real-smoke', audio: wav, cloud, signal: deadline, emotions: [...EMOTIONS],
        messages: [{ role: 'system', content: (config.brainMode === 'agent' ? footballPrompt : baselinePrompt)([...EMOTIONS]) }],
        reply: config.brainMode === 'agent' ? (messages, signal, timings) => agentReply({ cloud, messages, signal, timings, onQuery: () => { stage = 'querying'; }, onTool: observation => tools.push(observation) }) : undefined,
        onQuestion: text => { report.transcript = text; },
        send: event => {
          if (event.type === 'turn.state') stage = event.state;
          if (event.type === 'speech.segment') segments.push({ sequence: event.sequence, text: event.text, emotion: event.emotion, action: event.action, style: event.style });
          if (event.type === 'speech.audio') writeFileSync(join(directory, 'reply-' + event.sequence + '.wav'), Buffer.from(event.data, 'base64'));
        },
      });
      Object.assign(report, { success: true, answer: result.answer, timings: result.timings, segments, tools, completedAt: new Date().toISOString() });
      writeFileSync(join(directory, 'report.json'), safe(report) + '\n');
      console.log(safe(report));
    } catch (error) {
      Object.assign(report, { success: false, failedStage: stage, errorCode: error instanceof CloudError || error instanceof TurnError ? error.code : error instanceof Error ? error.name : 'unknown', status: error instanceof CloudError ? error.status : undefined, message: error instanceof CloudError || error instanceof TurnError ? error.message : '本次真实接口验证未完成。' });
      writeFileSync(join(directory, 'report.json'), safe(report) + '\n');
      console.error(safe(report)); process.exitCode = 1;
    }
    return;
  }
  const signal = AbortSignal.timeout(config.turnTimeoutMs);
  const transcript = await cloud.transcribe(simulatedWav(), signal);
  let reply = '';
  for await (const text of cloud.streamReply([{ role: 'user', content: transcript }], signal)) reply += text;
  const audio = await cloud.synthesize({ text: reply }, signal);
  console.log(JSON.stringify({ mode: cloud.mode, evidence: 'simulated', transcript, reply, audioBytes: audio.data.length }));
}
main().catch(error => {
  console.error(error instanceof ConfigError || error instanceof CloudError ? error.message : '诊断未完成：模拟模式使用 --fake；真实模式使用 --real 加 --audio <WAV文件> 或 --speech-fixture，并确认官方接口配置。');
  process.exitCode = 1;
});
