import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../src/server/app.ts';
import { readConfig } from '../src/server/config.ts';
import { createFakeCloud } from '../src/server/cloud/fake.ts';
import { simulatedWav } from '../src/server/cloud/audio.ts';
import { client } from './helpers/socket.ts';

test('模型遗漏表情或复述关系禁语时，演出仍使用受支持表情和友好转向', async () => {
  const cloud = createFakeCloud(); cloud.streamReply = async function* () { yield '规则不允许我说想你、等你回来这类话。'; };
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: ':memory:' }), cloud }); const connection = client(app.url);
  try {
    await connection.hello(); connection.send({ type: 'turn.submit', turnId: 'persona-output-guard', audio: { format: 'wav', data: simulatedWav().toString('base64') } });
    const done = await connection.wait(e => e.type === 'turn.done' && e.turnId === 'persona-output-guard');
    assert.equal(done.type === 'turn.done' && done.answer, '我们轻松聊聊足球吧。');
    const segment = connection.events.find(e => e.type === 'speech.segment' && e.turnId === 'persona-output-guard');
    assert.equal(segment?.type === 'speech.segment' && segment.emotion, 'neutral');
  } finally { connection.close(); await app.close(); }
});

test('无声、超长录音在识别前拒绝，ASR超时后下一轮仍可受理', async () => {
  const cloud = createFakeCloud(); let recognitions = 0;
  cloud.transcribe = async (_audio, signal) => {
    recognitions++;
    if (recognitions === 1) return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    return '恢复后的新问题';
  };
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: ':memory:', MAX_RECORDING_SECONDS: '1', TURN_TIMEOUT_MS: '1000' }), cloud });
  const connection = client(app.url);
  try {
    await connection.hello();
    const silent = simulatedWav().subarray(0, 44 + 24000); silent.writeUInt32LE(silent.length - 8, 4); silent.writeUInt32LE(silent.length - 44, 40); silent.fill(0, 44);
    for (const [turnId, data, code] of [['silent-recording', silent, 'empty_audio'], ['long-recording', simulatedWav(), 'audio_too_long']] as const) {
      connection.send({ type: 'turn.submit', turnId, audio: { format: 'wav', data: data.toString('base64') } });
      const event = await connection.wait(e => e.type === 'turn.error' && e.turnId === turnId);
      assert.equal(event.type === 'turn.error' && event.code, code);
    }
    assert.equal(recognitions, 0);
    const short = simulatedWav().subarray(0, 44 + 24000); short.writeUInt32LE(short.length - 8, 4); short.writeUInt32LE(short.length - 44, 40);
    connection.send({ type: 'turn.submit', turnId: 'timeout-recording', audio: { format: 'wav', data: short.toString('base64') } });
    const timedOut = await connection.wait(e => e.type === 'turn.error' && e.turnId === 'timeout-recording');
    assert.equal(timedOut.type === 'turn.error' && timedOut.code, 'turn_cancelled_or_timeout');
    connection.send({ type: 'turn.submit', turnId: 'recovered-recording', audio: { format: 'wav', data: short.toString('base64') } });
    await connection.wait(e => e.type === 'turn.done' && e.turnId === 'recovered-recording');
    assert.equal(recognitions, 2);
  } finally { connection.close(); await app.close(); }
});

test('跨块未知标签和连续标点不进入口播，末尾无标点文字不丢失', async () => {
  const cloud = createFakeCloud(); const spoken: string[] = [];
  cloud.streamReply = async function* () {
    yield '<emo:hap'; yield 'py><act:nod>(开心)第一句！'; yield '！<unknown:danger><act:fly><emo:unsupported>第二'; yield '句';
  };
  const synthesize = cloud.synthesize;
  cloud.synthesize = async (input, signal) => { if (input.text !== '嗨，我是小糖，今天想聊点什么呀？') spoken.push(input.text); return synthesize(input, signal); };
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: ':memory:' }), cloud });
  const connection = client(app.url);
  try {
    await connection.hello();
    connection.send({ type: 'turn.submit', turnId: 'parser-utterance', audio: { format: 'wav', data: simulatedWav().toString('base64') } });
    const done = await connection.wait(e => e.type === 'turn.done' && e.turnId === 'parser-utterance');
    assert.equal(done.type === 'turn.done' && done.answer, '第一句！第二句');
    assert.deepEqual(spoken, ['第一句！', '第二句']);
    const segments = connection.events.filter(e => e.type === 'speech.segment' && e.turnId === 'parser-utterance');
    assert.equal(segments.length, 2);
  } finally { connection.close(); await app.close(); }
});

test('合成失败返回纯文本降级且不产生成功完成事件', async () => {
  const cloud = createFakeCloud(); const synthesize = cloud.synthesize;
  cloud.streamReply = async function* () { yield '<emo:happy>(开心)这句应当作为文字保留。'; };
  cloud.synthesize = async (input, signal) => { if (input.text === '这句应当作为文字保留。') throw new Error('external-tts-failure'); return synthesize(input, signal); };
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: ':memory:' }), cloud });
  const connection = client(app.url);
  try {
    await connection.hello();
    connection.send({ type: 'turn.submit', turnId: 'tts-failure-turn', audio: { format: 'wav', data: simulatedWav().toString('base64') } });
    const error = await connection.wait(e => e.type === 'turn.error' && e.turnId === 'tts-failure-turn');
    assert.equal(error.type === 'turn.error' && error.fallbackText, '这句应当作为文字保留。');
    assert.equal(connection.events.some(e => e.type === 'turn.done' && e.turnId === 'tts-failure-turn'), false);
  } finally { connection.close(); await app.close(); }
});

test('真实WS连接的模拟开场白带字幕、动作与可播放WAV', async () => {
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: ':memory:' }) });
  const socket = new WebSocket(app.url.replace('http:', 'ws:') + '/ws?token=test');
  const events: Record<string, any>[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待模拟开场白超时')), 3000);
      socket.on('error', error => { clearTimeout(timer); reject(error); });
      socket.on('message', data => {
        const event = JSON.parse(data.toString()); events.push(event);
        if (event.type === 'session.ready') socket.send(JSON.stringify({ type: 'hello', version: 1, expressions: ['happy', 'relaxed'] }));
        if (event.type === 'turn.done') { clearTimeout(timer); resolve(); }
      });
    });
    assert.equal(events[0].type, 'session.ready');
    const segment = events.find(event => event.type === 'speech.segment');
    assert.equal(segment?.text, '嗨，我是小糖，今天想聊点什么呀？');
    assert.equal(segment?.emotion, 'happy');
    const audio = events.find(event => event.type === 'speech.audio');
    assert.equal(Buffer.from(audio!.data, 'base64').subarray(0, 4).toString(), 'RIFF');
    assert.equal(events.at(-1)?.greeting, true);
    assert.equal(events.every(event => event.sessionId === events[0].sessionId), true);
  } finally { socket.terminate(); await app.close(); }
});

test('不正确的WAV编码在云调用前被拒绝', async () => {
  const cloud = createFakeCloud(); let recognitions = 0;
  cloud.transcribe = async () => { recognitions++; return '不应该识别到这里'; };
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: ':memory:' }), cloud });
  const connection = client(app.url);
  try {
    await connection.hello();
    const wav = simulatedWav(); wav.writeUInt32LE(0, 16);
    connection.send({ type: 'turn.submit', turnId: 'bad-recording-01', audio: { format: 'wav', data: wav.toString('base64') } });
    const error = await connection.wait(event => event.type === 'turn.error' && event.turnId === 'bad-recording-01');
    assert.equal(error.type === 'turn.error' && error.code, 'invalid_audio');
    assert.equal(recognitions, 0);
  } finally { connection.close(); await app.close(); }
});

test('空播放确认不能跳过hello提前触发识别', async () => {
  const cloud = createFakeCloud(); let recognitions = 0;
  cloud.transcribe = async () => { recognitions++; return '不应受理'; };
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: ':memory:' }), cloud });
  const connection = client(app.url);
  try {
    await connection.wait(event => event.type === 'session.ready');
    connection.send({ type: 'playback.done', turnId: '' });
    connection.send({ type: 'turn.submit', turnId: 'early-recording-1', audio: { format: 'wav', data: simulatedWav().toString('base64') } });
    const error = await connection.wait(event => event.type === 'turn.error' && event.turnId === 'early-recording-1');
    assert.equal(error.type === 'turn.error' && error.code, 'not_ready');
    assert.equal(recognitions, 0);
  } finally { connection.close(); await app.close(); }
});

test('真实WS回合把识别文本交给大脑并按句输出去标签的声音与回答', async () => {
  const cloud = createFakeCloud(); let generatedFor = '';
  cloud.transcribe = async () => '我喜欢阿森纳';
  cloud.streamReply = async function* (messages, signal) {
    signal.throwIfAborted(); generatedFor = messages.at(-1)!.content;
    yield '<emo:hap'; yield 'py><act:nod>(开心)那就聊聊'; yield '阿森纳！';
  };
  const app = await startServer({ config: readConfig({ CLOUD_MODE: 'fake', ACCESS_TOKEN: 'test', PORT: '0', DATABASE_PATH: ':memory:' }), cloud });
  const socket = new WebSocket(app.url.replace('http:', 'ws:') + '/ws?token=test');
  const events: Record<string, any>[] = []; const turnId = 'utterance-0001';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待对话回合超时')), 4000);
      socket.on('error', error => { clearTimeout(timer); reject(error); });
      socket.on('message', data => {
        const event = JSON.parse(data.toString()); events.push(event);
        if (event.type === 'session.ready') socket.send(JSON.stringify({ type: 'hello', version: 1, expressions: ['happy', 'relaxed'] }));
        if (event.type === 'turn.done' && event.greeting) {
          socket.send(JSON.stringify({ type: 'playback.done', version: 1, turnId: event.turnId }));
          socket.send(JSON.stringify({ type: 'turn.submit', version: 1, turnId, audio: { format: 'wav', data: simulatedWav().toString('base64') } }));
        }
        if (event.type === 'turn.error') { clearTimeout(timer); reject(new Error(event.message)); }
        if (event.type === 'turn.done' && event.turnId === turnId) { clearTimeout(timer); resolve(); }
      });
    });
    const round = events.filter(event => event.turnId === turnId);
    assert.equal(generatedFor, '我喜欢阿森纳');
    assert.equal(round.find(event => event.type === 'transcript')?.text, '我喜欢阿森纳');
    assert.equal(round.find(event => event.type === 'speech.segment')?.text, '那就聊聊阿森纳！');
    assert.equal(round.find(event => event.type === 'speech.segment')?.emotion, 'happy');
    assert.equal(round.find(event => event.type === 'speech.segment')?.action, 'nod');
    assert.equal(round.at(-1)?.answer, '那就聊聊阿森纳！');
    assert.equal(round.find(event => event.type === 'speech.audio')?.mimeType, 'audio/wav');
  } finally { socket.terminate(); await app.close(); }
});
