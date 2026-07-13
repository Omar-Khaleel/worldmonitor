export type BroadcastTranslationMode = 'server' | 'ollama' | 'off';

export interface LiveBroadcastConfig {
  version: 2;
  updatedAt: number;
  channelName: string;
  channelSubtitle: string;
  panelIds: string[];
  showMap: boolean;
  columns: 1 | 2 | 3 | 4;
  gapPx: number;
  tickerEnabled: boolean;
  tickerSpeedSeconds: number;
  tickerLimit: number;
  forceArabic: boolean;
  translatePanelHeadlines: boolean;
  translationMode: BroadcastTranslationMode;
  ollamaUrl: string;
  ollamaModel: string;
  liveChannelIds: string[];
  webcamIds: string[];
  mapLayerIds: string[];
  mediaColumns: 1 | 2 | 3 | 4;
  showMediaWall: boolean;
}

const CONFIG_KEY = 'ayn-al-saqr-broadcast-config-v1';
const STATION_KEY = 'ayn-al-saqr-station-id-v1';
const CONTROL_KEY = 'ayn-al-saqr-control-key-v1';
const CHANNEL_NAME = 'ayn-al-saqr-live-control-v1';
const STATION_PARAM = 'station';
const BCFG_PARAM = 'bcfg';

const subscribers = new Set<(config: LiveBroadcastConfig) => void>();
let channel: BroadcastChannel | null = null;
let pollTimer: number | null = null;
let lastRemoteVersion = 0;
let listenersInstalled = false;

function randomToken(bytes = 12): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, (value) => value.toString(16).padStart(2, '0')).join('');
}

function safeStorageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeStorageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* kiosk storage may be disabled */ }
}

function parseStoredConfig(raw: string | null): Partial<LiveBroadcastConfig> {
  if (!raw) return {};
  try { return JSON.parse(raw) as Partial<LiveBroadcastConfig>; } catch { return {}; }
}

function decodeUrlConfig(encoded: string | null): Partial<LiveBroadcastConfig> {
  if (!encoded) return {};
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Partial<LiveBroadcastConfig>;
  } catch {
    return {};
  }
}

function strings(value: unknown, max = 160): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)))
    .slice(0, max);
}

export function normalizeLiveConfig(input: Partial<LiveBroadcastConfig>): LiveBroadcastConfig {
  const columns = [1, 2, 3, 4].includes(Number(input.columns)) ? Number(input.columns) as 1 | 2 | 3 | 4 : 3;
  const mediaColumns = [1, 2, 3, 4].includes(Number(input.mediaColumns)) ? Number(input.mediaColumns) as 1 | 2 | 3 | 4 : 2;
  const translationMode: BroadcastTranslationMode = input.translationMode === 'off' || input.translationMode === 'ollama'
    ? input.translationMode
    : 'server';

  return {
    version: 2,
    updatedAt: Number.isFinite(Number(input.updatedAt)) ? Number(input.updatedAt) : Date.now(),
    channelName: typeof input.channelName === 'string' && input.channelName.trim() ? input.channelName.trim().slice(0, 80) : 'عين الصقر',
    channelSubtitle: typeof input.channelSubtitle === 'string' ? input.channelSubtitle.trim().slice(0, 120) : 'قناة الأخبار والمعلومات والتحليل',
    panelIds: strings(input.panelIds, 120),
    showMap: input.showMap !== false,
    columns,
    gapPx: Math.max(0, Math.min(24, Number(input.gapPx ?? 0))),
    tickerEnabled: input.tickerEnabled !== false,
    tickerSpeedSeconds: Math.max(15, Math.min(180, Number(input.tickerSpeedSeconds ?? 48))),
    tickerLimit: Math.max(5, Math.min(60, Number(input.tickerLimit ?? 24))),
    forceArabic: input.forceArabic !== false,
    translatePanelHeadlines: input.translatePanelHeadlines !== false,
    translationMode,
    ollamaUrl: typeof input.ollamaUrl === 'string' && input.ollamaUrl.trim() ? input.ollamaUrl.trim().replace(/\/$/, '') : 'http://127.0.0.1:11434',
    ollamaModel: typeof input.ollamaModel === 'string' && input.ollamaModel.trim() ? input.ollamaModel.trim().slice(0, 120) : 'qwen2.5:7b',
    liveChannelIds: strings(input.liveChannelIds, 80),
    webcamIds: strings(input.webcamIds, 40),
    mapLayerIds: strings(input.mapLayerIds, 120),
    mediaColumns,
    showMediaWall: input.showMediaWall !== false,
  };
}

export function loadLiveConfig(): LiveBroadcastConfig {
  const url = new URL(window.location.href);
  const fromUrl = decodeUrlConfig(url.searchParams.get(BCFG_PARAM));
  const fromStorage = parseStoredConfig(safeStorageGet(CONFIG_KEY));
  return normalizeLiveConfig(Object.keys(fromUrl).length > 0 ? { ...fromStorage, ...fromUrl } : fromStorage);
}

export function getStationId(): string {
  const url = new URL(window.location.href);
  const requested = url.searchParams.get(STATION_PARAM)?.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 48);
  if (requested && requested.length >= 6) {
    safeStorageSet(STATION_KEY, requested);
    return requested;
  }
  const stored = safeStorageGet(STATION_KEY);
  if (stored && /^[a-z0-9-]{6,48}$/.test(stored)) return stored;
  const generated = `ayn-${randomToken(6)}`;
  safeStorageSet(STATION_KEY, generated);
  return generated;
}

function getControlKey(): string {
  const stored = safeStorageGet(CONTROL_KEY);
  if (stored && stored.length >= 20) return stored;
  const generated = randomToken(24);
  safeStorageSet(CONTROL_KEY, generated);
  return generated;
}

export function buildLiveViewerUrl(): string {
  const url = new URL(window.location.href);
  url.pathname = '/broadcast';
  url.search = '';
  url.hash = '';
  url.searchParams.set(STATION_PARAM, getStationId());
  url.searchParams.set('lang', 'ar');
  return url.toString();
}

function getChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (!('BroadcastChannel' in window)) return null;
  channel = new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

function announceStatus(state: string, detail = ''): void {
  window.dispatchEvent(new CustomEvent('ayn-broadcast-sync-status', { detail: { state, detail } }));
}

function dispatchConfig(config: LiveBroadcastConfig): void {
  for (const subscriber of subscribers) {
    try { subscriber(config); } catch (error) { console.warn('[عين الصقر] sync subscriber failed', error); }
  }
}

function ensureListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  const station = getStationId();
  const bc = getChannel();
  bc?.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as { type?: string; station?: string; config?: Partial<LiveBroadcastConfig> };
    if (message?.type !== 'config' || message.station !== station || !message.config) return;
    dispatchConfig(normalizeLiveConfig(message.config));
  });

  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== CONFIG_KEY || !event.newValue) return;
    dispatchConfig(normalizeLiveConfig(parseStoredConfig(event.newValue)));
  });

  window.addEventListener('ayn-broadcast-config', (event: Event) => {
    const custom = event as CustomEvent<Partial<LiveBroadcastConfig>>;
    if (custom.detail) dispatchConfig(normalizeLiveConfig(custom.detail));
  });
}

async function pushRemote(config: LiveBroadcastConfig): Promise<void> {
  const station = getStationId();
  try {
    const response = await fetch(`/api/broadcast/state?station=${encodeURIComponent(station)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, controlKey: getControlKey() }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    announceStatus('online', 'تم نشر التحديث على رابط المحطة');
  } catch (error) {
    announceStatus('local', error instanceof Error ? error.message : 'remote sync unavailable');
  }
}

export function publishLiveConfig(input: Partial<LiveBroadcastConfig>, remote = true): LiveBroadcastConfig {
  ensureListeners();
  const config = normalizeLiveConfig({ ...loadLiveConfig(), ...input, updatedAt: Date.now() });
  safeStorageSet(CONFIG_KEY, JSON.stringify(config));
  getChannel()?.postMessage({ type: 'config', station: getStationId(), config });
  window.dispatchEvent(new CustomEvent('ayn-broadcast-config', { detail: config }));
  if (remote) void pushRemote(config);
  return config;
}

async function fetchRemoteConfig(): Promise<void> {
  const station = getStationId();
  try {
    const response = await fetch(`/api/broadcast/state?station=${encodeURIComponent(station)}&after=${lastRemoteVersion}`, {
      cache: 'no-store',
    });
    if (response.status === 204 || response.status === 404) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { config?: Partial<LiveBroadcastConfig>; version?: number };
    const version = Number(payload.version || payload.config?.updatedAt || 0);
    if (!payload.config || version <= lastRemoteVersion) return;
    lastRemoteVersion = version;
    const config = normalizeLiveConfig(payload.config);
    safeStorageSet(CONFIG_KEY, JSON.stringify(config));
    dispatchConfig(config);
    announceStatus('online', 'وصل تحديث مباشر من غرفة التحكم');
  } catch {
    // BroadcastChannel/localStorage remain available for local previews.
  }
}

export function subscribeLiveConfig(onConfig: (config: LiveBroadcastConfig) => void): () => void {
  ensureListeners();
  subscribers.add(onConfig);
  void fetchRemoteConfig();
  if (pollTimer === null) pollTimer = window.setInterval(() => void fetchRemoteConfig(), 1000);

  return () => {
    subscribers.delete(onConfig);
    if (subscribers.size === 0 && pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };
}
