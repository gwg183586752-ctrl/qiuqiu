import { useEffect, useRef, useState } from 'react';
import { AvatarStage } from './avatar.ts';
import { SpeechPlayer } from './player.ts';
import { BrowserRecorder, encodeBase64 } from './recorder.ts';
import type { ClientConfig, ServerEvent } from '../shared/protocol.ts';
import './style.css';

type Phase = 'loading' | 'connecting' | 'audioActivation' | 'idle' | 'openingMic' | 'recording' | 'processing' | 'querying' | 'playing' | 'replaced' | 'error';
const labels: Record<Phase, string> = { loading: '小糖正在准备', connecting: '正在连接', audioActivation: '等待开启声音', idle: '可以开始聊天', openingMic: '正在开启麦克风', recording: '正在听你说', processing: '小糖正在思考', querying: '查询中', playing: '小糖正在说话', replaced: '会话已在其他页面继续', error: '需要再试一下' };

export default function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const controls = useRef<{ primary(): Promise<void> } | null>(null);
  const phaseRef = useRef<Phase>('loading');
  const [phase, setPhase] = useState<Phase>('loading');
  const [subtitle, setSubtitle] = useState('');
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'fake' | 'real'>('real');
  const [ready, setReady] = useState(false);
  const [microphones, setMicrophones] = useState<{ deviceId: string; label: string }[]>([]);
  const [selectedMicrophone, setSelectedMicrophone] = useState('');
  const microphoneId = useRef('');
  const [currentMicrophone, setCurrentMicrophone] = useState('');
  const [recordingLevel, setRecordingLevel] = useState(0);
  const chooseMicrophone = (deviceId: string) => {
    microphoneId.current = deviceId; setSelectedMicrophone(deviceId); setCurrentMicrophone('');
    try { localStorage.setItem('qiuqiu.microphone.v1', deviceId); } catch { /* 当前页面仍沿用本次选择。 */ }
  };
  const changePhase = (next: Phase) => { phaseRef.current = next; setPhase(next); };

  useEffect(() => {
    let disposed = false; let replaced = false; let socket: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined; let attempts = 0; let storageUnavailable = false;
    let sessionId = ''; let epoch = 0; let activeTurn = ''; let expressions: string[] = [];
    let maxRecordingSeconds = 30; let avatarReady = false; let controlAttempt = 0;
    const completed = new Set<string>(); const submitted = new Map<string, number>();
    const rememberCompleted = (turnId: string) => {
      completed.add(turnId); submitted.delete(turnId);
      if (completed.size > 64) completed.delete(completed.values().next().value!);
    };
    const recorder = new BrowserRecorder(); const abort = new AbortController();
    const refreshMicrophones = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!disposed) setMicrophones(devices.filter(device => device.kind === 'audioinput' && device.deviceId).map((device, index) => ({ deviceId: device.deviceId, label: device.label || '麦克风 ' + (index + 1) })));
      } catch { /* 权限提示与录音错误由实际采集入口处理。 */ }
    };
    try { microphoneId.current = localStorage.getItem('qiuqiu.microphone.v1') || ''; setSelectedMicrophone(microphoneId.current); } catch { /* 设备偏好可仅保留在本页。 */ }
    void refreshMicrophones(); navigator.mediaDevices?.addEventListener('devicechange', refreshMicrophones);
    let avatar: AvatarStage | undefined;
    const send = (message: Record<string, unknown>) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ version: 1, ...message })); };
    const fail = (message: string) => {
      if (disposed || replaced) return;
      controlAttempt++;
      if (activeTurn) rememberCompleted(activeTurn);
      activeTurn = ''; recorder.cancel(); setRecordingLevel(0); player.stop(); avatar?.reset(); setError(message); changePhase('error');
    };
    const player = new SpeechPlayer({
      onActivation: () => { if (!disposed && !replaced) changePhase('audioActivation'); },
      onSegment: segment => { if (!disposed && !replaced) { setSubtitle(segment.text); avatar?.present(segment); changePhase('playing'); } },
      onWaiting: () => { if (!disposed && !replaced && phaseRef.current !== 'audioActivation') changePhase('processing'); },
      onComplete: turnId => {
        if (disposed || replaced || activeTurn !== turnId) return;
        rememberCompleted(turnId); activeTurn = ''; avatar?.reset(); setError(''); changePhase('idle'); send({ type: 'playback.done', turnId });
      },
      onError: message => { fail(message); socket?.close(); },
      onFirstAudio: turnId => { const start = submitted.get(turnId); if (start !== undefined) { send({ type: 'metric', turnId, firstAudioMs: performance.now() - start }); submitted.delete(turnId); } },
    });

    const connect = async () => {
      if (disposed || replaced) return;
      attempts++; storageUnavailable = false; changePhase('connecting');
      try {
        const response = await fetch('/client-config', { signal: abort.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('无法读取本机连接配置。');
        const config = await response.json() as ClientConfig;
        const access = await fetch('/connection-check', { method: 'POST', headers: { 'X-Access-Token': config.accessToken }, signal: abort.signal });
        if (access.status === 401 || access.status === 403) throw new Error('连接校验失败，请检查本机共享口令配置，再点击重试。');
        if (!access.ok) throw new Error('本机连接暂时不可用，请稍后重试。');
        setMode(config.mode); maxRecordingSeconds = config.maxRecordingSeconds;
        let saved: string;
        try { saved = localStorage.getItem('qiuqiu.session.v1') || ''; } catch { throw new Error('浏览器无法保存会话身份，请允许本站本地存储后重试。'); }
        const url = new URL('/ws', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('token', config.accessToken); if (saved) url.searchParams.set('sessionId', saved);
        const connection = new WebSocket(url); socket = connection;
        connection.onmessage = message => {
          if (disposed || replaced || connection !== socket) return;
          try {
            const event = JSON.parse(String(message.data)) as ServerEvent;
            if (event.version !== 1) return;
            if (event.type === 'session.ready') {
              sessionId = event.sessionId; epoch = event.connectionEpoch; attempts = 0;
              try { localStorage.setItem('qiuqiu.session.v1', sessionId); } catch { storageUnavailable = true; fail('无法保存会话身份，请允许本站本地存储后重试。'); connection.close(); return; }
              setError(''); changePhase(event.isNew ? 'processing' : 'idle');
              send({ type: 'hello', expressions }); return;
            }
            if (event.sessionId !== sessionId || event.connectionEpoch !== epoch) return;
            if (event.type === 'session.replaced') {
              replaced = true; clearTimeout(reconnect); activeTurn = ''; recorder.cancel(); setRecordingLevel(0); player.stop(); avatar?.reset(); changePhase('replaced'); connection.close(); return;
            }
            if (event.type === 'turn.error') {
              if (event.turnId && completed.has(event.turnId)) return;
              if (event.turnId && activeTurn && event.turnId !== activeTurn) return;
              if (event.fallbackText) setSubtitle(event.fallbackText);
              fail(event.message); return;
            }
            if (!('turnId' in event) || completed.has(event.turnId)) return;
            if (event.type === 'turn.state' && !activeTurn) { activeTurn = event.turnId; player.begin(activeTurn); }
            if (event.turnId !== activeTurn) return;
            if (event.type === 'turn.state' && !['playing', 'audioActivation'].includes(phaseRef.current)) changePhase(event.state === 'querying' ? 'querying' : 'processing');
            if (event.type === 'speech.segment') player.segment(event.turnId, event);
            if (event.type === 'speech.audio') player.supply(event.turnId, event.sequence, event.data);
            if (event.type === 'turn.done') player.finish(event.turnId);
          } catch { fail('连接数据有些异常，请刷新后重试。'); }
        };
        connection.onerror = () => { if (!disposed && !replaced) setError('连接未建立，请检查本机服务与口令配置。'); };
        connection.onclose = () => {
          if (disposed || replaced || storageUnavailable || connection !== socket) return;
          fail('连接已断开，正在尝试恢复。');
          if (attempts < 3) reconnect = setTimeout(() => { void connect(); }, 1000);
          else setError('连接未恢复，请检查服务和口令配置，再点击重试。');
        };
      } catch (reason) { if (!disposed) fail(reason instanceof Error ? reason.message : '暂时无法连接，请重试。'); }
    };

    controls.current = { primary: async () => {
      const attempt = ++controlAttempt;
      try {
        if (!avatarReady) { location.reload(); return; }
        if (phaseRef.current === 'audioActivation') { await player.activate(); return; }
        if (phaseRef.current === 'recording') {
          const endedAt = performance.now();
          changePhase('processing'); setRecordingLevel(0); const bytes = await recorder.finish();
          if (attempt !== controlAttempt || disposed || replaced) return;
          if (socket?.readyState !== WebSocket.OPEN) throw new Error('连接已断开，请重试。');
          activeTurn = crypto.randomUUID(); player.begin(activeTurn); submitted.set(activeTurn, endedAt); setSubtitle('');
          send({ type: 'turn.submit', turnId: activeTurn, audio: { format: 'wav', data: encodeBase64(bytes) } }); return;
        }
        if (!['idle', 'error'].includes(phaseRef.current)) return;
        if (socket?.readyState !== WebSocket.OPEN) { attempts = 0; await connect(); return; }
        changePhase('openingMic'); setError(''); setSubtitle(''); await player.activate();
        await recorder.start(maxRecordingSeconds, () => fail('录音已达到时长限制，请缩短后再试。'), fail, {
          deviceId: microphoneId.current,
          onDevice: label => { if (!disposed && !replaced) { setCurrentMicrophone(label); void refreshMicrophones(); } },
          onLevel: value => { if (!disposed && !replaced) setRecordingLevel(value); },
        });
        if (attempt === controlAttempt && !disposed && !replaced && phaseRef.current === 'openingMic') changePhase('recording');
      } catch (reason) {
        if (attempt !== controlAttempt || disposed || replaced) return;
        if (reason instanceof DOMException || (reason instanceof Error && reason.name === 'OverconstrainedError')) {
          const messages: Record<string, string> = { NotAllowedError: '请允许使用麦克风，再点击重试。', NotFoundError: '没有找到可用的麦克风，请连接设备后重试。', NotReadableError: '麦克风暂时不可用，请检查是否被其他应用占用。', OverconstrainedError: '选中的麦克风不可用，请在麦克风设置中重新选择。', AbortError: '麦克风开启被中断，请重试。' };
          fail(messages[reason.name] ?? '麦克风暂时不可用，请重试。');
        } else fail(reason instanceof Error ? reason.message : '麦克风暂时不可用，请重试。');
      }
    } };

    try {
      avatar = new AvatarStage(canvas.current!, player.volume);
      void avatar.load().then(supported => {
        if (disposed) return; expressions = supported; avatarReady = true; setReady(true); void connect();
      }).catch(() => fail('角色暂时没有加载成功，请刷新后重试。'));
    } catch { fail('浏览器无法启动数字人画面，请检查 WebGL 支持后重试。'); }

    return () => {
      disposed = true; controls.current = null; abort.abort(); clearTimeout(reconnect);
      navigator.mediaDevices?.removeEventListener('devicechange', refreshMicrophones);
      socket?.close(); recorder.cancel(); player.destroy(); avatar?.dispose();
    };
  }, []);

  const enabled = ['audioActivation', 'idle', 'recording', 'error'].includes(phase);
  const button = phase === 'audioActivation' ? '开启声音' : phase === 'recording' ? '结束并发送' : phase === 'error' ? '重试' : phase === 'idle' ? '开始录音' : phase === 'replaced' ? '已由其他页面接管' : '请稍等';
  return <main className="app-shell" data-phase={phase}>
    <header className="masthead"><a className="brand" href="/" aria-label="小糖首页"><span className="ball-mark">✦</span> FOOTBALL MOMENTS</a><span className="local-mark">一场轻松的足球闲聊</span></header>
    <section className="conversation" aria-label="与小糖对话">
      <div className="intro"><span className="eyebrow">YOUR FOOTBALL COMPANION</span><h1>小糖，陪你聊聊足球<span>。</span></h1><p>从一粒进球，到你喜欢的那支球队。</p></div>
      <div className="stage"><div className="pitch-line" aria-hidden="true"/><div className="stage-glow" aria-hidden="true"/>
        <canvas ref={canvas} role="img" aria-label="小糖数字人" aria-busy={!ready} data-ready={ready} />
        {!ready && <div className="loading-note">{error || '小糖正在来到球场…'}</div>}
        <span className="name-tag">小糖 <i/> 今天也想听你说</span>
      </div>
      <div className="dialogue"><div className={`status-dot ${phase === 'recording' ? 'recording' : ''}`} role="status" aria-live="polite">{mode === 'fake' ? '模拟演示 · ' : ''}{labels[phase]}</div>
        <p className="subtitle" data-testid="subtitle" aria-live="polite">{subtitle || (phase === 'recording' ? '说完后，再点一下发送。' : '关于足球，今天想聊些什么？')}</p>
        {error && <p className="error-note" role="alert">{error}</p>}
        {phase === 'recording' && <div className="microphone-level"><meter aria-label="麦克风音量" min={0} max={1} value={recordingLevel}/><span>说话时音量条应有变化</span></div>}
        {['idle', 'error', 'recording'].includes(phase) && (microphones.length > 0 || currentMicrophone) && <details className="microphone-settings" open={phase === 'error' && /麦克风|录音|有效声音/.test(error) ? true : undefined}>
          <summary>麦克风设置</summary>
          {currentMicrophone && <p>当前输入：{currentMicrophone}</p>}
          <label htmlFor="microphone-input">输入设备</label>
          <select id="microphone-input" value={selectedMicrophone} disabled={!['idle', 'error'].includes(phase)} onChange={event => chooseMicrophone(event.target.value)}>
            <option value="">浏览器默认输入（录音时显示实际设备）</option>
            {selectedMicrophone && !microphones.some(device => device.deviceId === selectedMicrophone) && <option value={selectedMicrophone}>上次选择的设备（当前不可用）</option>}
            {microphones.filter(device => device.deviceId !== 'default').map(device => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
          </select>
        </details>}
        <button className={`record-button ${phase === 'recording' ? 'is-recording' : ''}`} disabled={!enabled} onClick={() => { void controls.current?.primary(); }}>
          <span className="button-icon" aria-hidden="true">{phase === 'recording' ? <span className="stop-icon"/> : <svg viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4m-3 0h6"/></svg>}</span><span>{button}</span>
        </button><p className="interaction-note">点一下开始说，再点一下发送</p>
      </div>
    </section>
    <footer className="footer"><span>好球，总值得聊两句。</span><span>小糖 · FOOTBALL MOMENTS</span></footer>
  </main>;
}
