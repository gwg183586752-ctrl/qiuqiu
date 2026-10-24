import WebSocket from 'ws';
import type { ServerEvent } from '../../src/shared/protocol.ts';

export function client(url: string, sessionId?: string) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws?token=test' + (sessionId ? '&sessionId=' + encodeURIComponent(sessionId) : ''));
  const events: ServerEvent[] = [];
  const listeners = new Set<{ predicate(event: ServerEvent): boolean; resolve(event: ServerEvent): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  socket.on('message', raw => {
    const event = JSON.parse(raw.toString()) as ServerEvent; events.push(event);
    for (const listener of listeners) if (listener.predicate(event)) { clearTimeout(listener.timer); listeners.delete(listener); listener.resolve(event); }
  });
  socket.on('error', error => { for (const listener of listeners) { clearTimeout(listener.timer); listener.reject(error); } listeners.clear(); });
  const wait = (predicate: (event: ServerEvent) => boolean, timeout = 3000): Promise<ServerEvent> => {
    const found = events.find(predicate); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const listener = { predicate, resolve, reject, timer: setTimeout(() => { listeners.delete(listener); reject(new Error('等待协议事件超时')); }, timeout) };
      listeners.add(listener);
    });
  };
  const send = (value: Record<string, unknown>) => socket.send(JSON.stringify({ version: 1, ...value }));
  return {
    socket, events, wait, send,
    async hello() {
      const ready = await wait(event => event.type === 'session.ready');
      send({ type: 'hello', expressions: ['happy', 'relaxed', 'sad', 'angry', 'surprised', 'neutral'] });
      if (ready.type === 'session.ready' && ready.isNew) {
        const greeting = await wait(event => event.type === 'turn.done' && !!event.greeting);
        if (greeting.type === 'turn.done') send({ type: 'playback.done', turnId: greeting.turnId });
      }
      return ready;
    },
    close() {
      for (const listener of listeners) { clearTimeout(listener.timer); listener.reject(new Error('测试连接关闭')); }
      listeners.clear(); socket.terminate();
    },
  };
}
