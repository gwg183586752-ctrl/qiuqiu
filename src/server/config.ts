export interface AppConfig {
  host: '127.0.0.1';
  port: number;
  cloudMode: 'fake' | 'real';
  brainMode: 'baseline' | 'agent';
  accessToken: string;
  mimoApiKey: string;
  mimoBaseUrl: string;
  chatModel: string;
  asrModel: string;
  ttsModel: string;
  voice: string;
  databasePath: string;
  auditPath: string;
  maxRecordingSeconds: number;
  turnTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(names: string[]) {
    super(`配置缺失或无效：${names.join('、')}`);
    this.name = 'ConfigError';
  }
}

export function readConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const invalid: string[] = [];
  const value = (name: string, fallback = '') => env[name]?.trim() || fallback;
  const required = (name: string) => {
    const result = value(name);
    if (!result) invalid.push(name);
    return result;
  };
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = value(name, String(fallback));
    const parsed = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) invalid.push(name);
    return parsed;
  };
  const cloudMode = value('CLOUD_MODE', 'real');
  const brainMode = value('BRAIN_MODE', 'baseline');
  if (cloudMode !== 'fake' && cloudMode !== 'real') invalid.push('CLOUD_MODE');
  if (brainMode !== 'baseline' && brainMode !== 'agent') invalid.push('BRAIN_MODE');
  const accessToken = required('ACCESS_TOKEN');
  const mimoApiKey = cloudMode === 'real' ? required('MIMO_API_KEY') : value('MIMO_API_KEY');
  const mimoBaseUrl = value('MIMO_BASE_URL', 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '');
  try {
    const url = new URL(mimoBaseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) invalid.push('MIMO_BASE_URL');
  } catch { invalid.push('MIMO_BASE_URL'); }
  const config: AppConfig = {
    host: '127.0.0.1', port: integer('PORT', 3000, 0, 65535),
    cloudMode: cloudMode as AppConfig['cloudMode'], brainMode: brainMode as AppConfig['brainMode'],
    accessToken, mimoApiKey, mimoBaseUrl,
    chatModel: value('MIMO_CHAT_MODEL', 'mimo-v2.6-flash'),
    asrModel: value('MIMO_ASR_MODEL', 'mimo-v2.5-asr'),
    ttsModel: value('MIMO_TTS_MODEL', 'mimo-v2.5-tts'), voice: value('MIMO_VOICE', '冰糖'),
    databasePath: value('DATABASE_PATH', 'data/football.sqlite'),
    auditPath: value('AUDIT_PATH', 'data/turns.jsonl'),
    maxRecordingSeconds: integer('MAX_RECORDING_SECONDS', 30, 1, 120),
    turnTimeoutMs: integer('TURN_TIMEOUT_MS', 90000, 1000, 300000),
  };
  if (invalid.length) throw new ConfigError([...new Set(invalid)]);
  return config;
}
