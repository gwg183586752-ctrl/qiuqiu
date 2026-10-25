import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from './config.ts';
import { createCloud } from './cloud/index.ts';
import type { CloudAdapters } from './cloud/types.ts';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { EMOTIONS, GREETING } from '../shared/protocol.ts';
import type { ServerPayload } from '../shared/protocol.ts';
import { ConversationStore } from './store/conversations.ts';
import { baselinePrompt, footballPrompt } from './prompt.ts';
import { agentReply } from './brain.ts';
import type { TimeProbe } from './tools.ts';
import { abortable, recording, runTurn, TurnError } from './pipeline.ts';
import { sameLocalOrigin, validToken } from './access.ts';

export type FrontendMiddleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => void;

export async function startServer({ config, cloud = createCloud(config), frontend, timeProbe }: { config: AppConfig; cloud?: CloudAdapters; frontend?: FrontendMiddleware; timeProbe?: TimeProbe }) {
  const store = new ConversationStore(config.databasePath, { secrets: [config.accessToken, config.mimoApiKey], auditPath: config.auditPath });
  const jobs = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const activeSessions = new Map<string, { epoch: number; replace(): void }>();
  let shuttingDown = false;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!sameLocalOrigin(request)) { response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('本机来源校验失败'); return; }
    if (request.method === 'POST' && request.url === '/connection-check') {
      const accepted = validToken(request.headers['x-access-token'], config.accessToken);
      response.writeHead(accepted ? 204 : 401); response.end(); return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'ready', mode: cloud.mode, protocolVersion: 1 }));
      return;
    }
    if (request.method === 'GET' && request.url === '/client-config') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ accessToken: config.accessToken, mode: cloud.mode, maxRecordingSeconds: config.maxRecordingSeconds }));
      return;
    }
    const notFound = () => {
      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: '入口不存在' }));
    };
    if (frontend) frontend(request, response, notFound); else notFound();
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 8_000_000 });
  server.on('upgrade', (request, socket, head) => {
    if (shuttingDown) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
    let url: URL;
    try { url = new URL(request.url ?? '/', 'http://localhost'); }
    catch { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    if (!sameLocalOrigin(request)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    if (url.pathname !== '/ws') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    if (!validToken(url.searchParams.get('token'), config.accessToken)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    sockets.handleUpgrade(request, socket, head, connection => { sockets.emit('connection', connection, request); });
  });
  sockets.on('connection', (connection, request) => {
    const session = store.resolveSession(new URL(request.url!, 'http://localhost').searchParams.get('sessionId'));
    const sessionId = session.id;
    const connectionEpoch = store.nextEpoch(sessionId);
    const controller = new AbortController();
    controllers.add(controller);
    let greeted = false;
    let busy = true;
    let activeTurn = '';
    let waitingPlayback = '';
    let supported = new Set<string>();
    const owns = () => !controller.signal.aborted && activeSessions.get(sessionId)?.epoch === connectionEpoch;
    const send = (payload: ServerPayload) => {
      if (connection.readyState === WebSocket.OPEN && owns()) connection.send(JSON.stringify({ version: 1, sessionId, connectionEpoch, ...payload }));
    };
    activeSessions.get(sessionId)?.replace();
    activeSessions.set(sessionId, { epoch: connectionEpoch, replace() {
      send({ type: 'session.replaced', message: '会话已在其他页面继续' });
      if (activeTurn && !activeTurn.startsWith('greeting-')) store.terminate(activeTurn, 'cancelled', 'session_replaced');
      controller.abort(); connection.close(4001, 'replaced');
    } });
    send({ type: 'session.ready', isNew: session.isNew, mode: cloud.mode, maxRecordingSeconds: config.maxRecordingSeconds });
    const lost = () => {
      if (activeTurn && !activeTurn.startsWith('greeting-')) {
        try { store.terminate(activeTurn, 'cancelled', 'connection_closed'); } catch { console.warn(JSON.stringify({ event: 'storage.terminal_failed', turnId: activeTurn })); }
      }
      controller.abort(); controllers.delete(controller);
      if (activeSessions.get(sessionId)?.epoch === connectionEpoch) activeSessions.delete(sessionId);
    };
    connection.on('close', lost);
    connection.on('error', lost);
    connection.on('message', (data, binary) => {
      if (!owns() || shuttingDown) return;
      let message: { type?: string; version?: number; expressions?: unknown; turnId?: unknown; audio?: unknown; firstAudioMs?: unknown };
      try {
        if (binary) throw new Error('binary');
        message = JSON.parse(data.toString());
        if (!message || message.version !== 1) throw new Error('version');
      } catch { send({ type: 'turn.error', code: 'invalid_message', message: '连接数据格式不正确，请刷新后重试。' }); return; }
      if (message.type === 'playback.done') {
        if (waitingPlayback && message.turnId === waitingPlayback) { waitingPlayback = ''; busy = false; activeTurn = ''; }
        return;
      }
      if (message.type === 'metric') {
        if (typeof message.turnId === 'string') store.metric(message.turnId, sessionId, connectionEpoch, message.firstAudioMs);
        return;
      }
      const track = (work: Promise<void>) => {
        jobs.add(work); void work.then(() => jobs.delete(work), () => jobs.delete(work));
      };
      if (message.type === 'turn.submit') {
        const turnId = message.turnId;
        if (typeof turnId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(turnId)) { send({ type: 'turn.error', code: 'invalid_turn', message: '回合信息不完整，请重新录制。' }); return; }
        if (!greeted) { send({ type: 'turn.error', turnId, code: 'not_ready', message: '连接还没准备好，请稍后再试。' }); return; }
        if (busy) {
          if (turnId === activeTurn && !turnId.startsWith('greeting-')) {
            try { store.beginTurn(sessionId, connectionEpoch, turnId, recording(message.audio, config.maxRecordingSeconds)); }
            catch { send({ type: 'turn.error', turnId, code: 'turn_conflict', message: '回合标识与录音内容不一致，请重新录制新的一轮。' }); }
          }
          if (turnId !== activeTurn) send({ type: 'turn.error', turnId, code: 'busy', message: '等我说完这一句，再继续聊吧。' });
          return;
        }
        let wav: Buffer;
        try {
          wav = recording(message.audio, config.maxRecordingSeconds);
          const record = store.beginTurn(sessionId, connectionEpoch, turnId, wav);
          if (!record.created) {
            if (record.status === 'completed') send({ type: 'turn.done', turnId, answer: record.answer ?? '' });
            else send({ type: 'turn.error', turnId, code: 'terminated_turn', message: '这一轮已结束，请重新录制新的发言。' });
            return;
          }
        } catch (error) {
          send({ type: 'turn.error', turnId, code: error instanceof TurnError ? error.code : 'turn_rejected', message: error instanceof TurnError ? error.message : '本轮暂时无法受理，请重新录制。' }); return;
        }
        busy = true; activeTurn = turnId;
        const started = performance.now();
        const timings: Record<string, number> = {};
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.turnTimeoutMs)]);
        track((async () => {
          try {
            const result = await runTurn({ turnId, audio: wav, cloud, signal, emotions: [...supported], timings,
              messages: [{ role: 'system', content: (config.brainMode === 'agent' ? footballPrompt : baselinePrompt)([...supported]) }, ...store.history(sessionId)],
              reply: config.brainMode === 'agent' ? (messages, signal, timings) => agentReply({ cloud, messages, signal, timings, timeProbe, onQuery: () => { store.stage(turnId, 'querying', performance.now() - started); send({ type: 'turn.state', turnId, state: 'querying' }); }, onTool: observation => store.tool(turnId, observation) }) : undefined,
              send: event => { if (event.type === 'turn.state') store.stage(turnId, event.state, performance.now() - started); send(event); }, onQuestion: text => store.question(turnId, text),
            });
            signal.throwIfAborted();
            store.complete(turnId, result.answer, result.timings, owns);
            waitingPlayback = turnId;
            send({ type: 'turn.done', turnId, answer: result.answer, timings: result.timings });
          } catch (error) {
            const cancelled = controller.signal.aborted;
            const code = error instanceof TurnError ? error.code : signal.aborted ? 'turn_cancelled_or_timeout' : 'turn_failed';
            try { store.timings(turnId, { ...timings, totalServerMs: performance.now() - started }); store.terminate(turnId, cancelled ? 'cancelled' : 'failed', code); }
            catch { console.warn(JSON.stringify({ event: 'storage.terminal_failed', turnId })); }
            busy = false; activeTurn = ''; waitingPlayback = '';
            send({ type: 'turn.error', turnId, code, message: error instanceof TurnError ? error.message : '出了点小状况，再说一次？', fallbackText: error instanceof TurnError ? error.fallbackText : undefined });
          }
        })());
        return;
      }
      if (message.type !== 'hello' || greeted) return;
      if (!Array.isArray(message.expressions) || message.expressions.length > 32) { send({ type: 'turn.error', code: 'invalid_hello', message: '角色信息不完整，请刷新后重试。' }); return; }
      greeted = true;
      supported = new Set(message.expressions.filter(value => typeof value === 'string' && (EMOTIONS as readonly string[]).includes(value)));
      if (!session.isNew) { busy = false; return; }
      store.scheduleGreeting(sessionId);
      const turnId = 'greeting-' + randomUUID(); activeTurn = turnId;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.turnTimeoutMs)]);
      track((async () => {
        try {
          send({ type: 'turn.state', turnId, state: 'synthesizing' });
          const audio = await abortable(cloud.synthesize({ text: GREETING, style: '开心、明亮、温暖' }, signal), signal);
          const segmentId = turnId + ':0';
          send({ type: 'speech.segment', turnId, sequence: 0, segmentId, text: GREETING, emotion: supported.has('happy') ? 'happy' : undefined, action: 'nod' });
          send({ type: 'speech.audio', turnId, sequence: 0, segmentId, data: audio.data.toString('base64'), mimeType: audio.mimeType, final: true });
          waitingPlayback = turnId;
          send({ type: 'turn.done', turnId, answer: GREETING, greeting: true });
        } catch {
          busy = false; activeTurn = ''; waitingPlayback = '';
          send({ type: 'turn.error', turnId, code: 'greeting_failed', message: '出了点小状况，稍后再试？', fallbackText: GREETING });
        }
      })());
    });
  });
  try { await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  }); } catch (error) { sockets.close(); store.close(); throw error; }
  const address = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${config.host}:${address.port}`,
    address: address.address,
    server,
    close() {
      closing ??= (async () => {
        shuttingDown = true;
        for (const controller of controllers) controller.abort();
        for (const connection of sockets.clients) connection.terminate();
        await Promise.allSettled([...jobs]);
        try {
          await Promise.all([
            new Promise<void>(resolve => sockets.close(() => resolve())),
            new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }),
          ]);
        } finally { store.close(); }
      })();
      return closing;
    },
  };
}
