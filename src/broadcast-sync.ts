export type BroadcastTranslationMode = 'server' | 'ollama' | 'off';

export interface BroadcastPanelSnapshot {
  id: string;
  title: string;
  items: string[];
  updatedAt: number;
}

export interface BroadcastMediaSource {
  id: string;
  kind: 'channel' | 'webcam';
  name: string;
  hlsUrl?: string;
  videoId?: string;
}

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
  panelSnapshots: BroadcastPanelSnapshot[];
  tickerHeadlines: string[];
  mediaSources: BroadcastMediaSource[];
  projectionUpdatedAt: number;
}

const CONFIG_KEY = 'ayn-al-saqr-broadcast-config-v1';
const STATION_KEY = 'ayn-al-saqr-station-id-v1';
const CONTROL_KEY = 'ayn-al-saqr-control-key-v1';
const CHANNEL_NAME = 'ayn-al-saqr-live-control-v2';
const STATION_PARAM = 'station';
const BCFG_PARAM = 'bcfg';

const subscribers = new Set<(config: LiveBroadcastConfig) => void>();
let channel: BroadcastChannel | null = null;
let pollTimer: number | null = null;
let lastRemoteVersion = 0;
let listenersInstalled = false;
let remoteFetchRunning = false;

function randomToken(bytes = 12): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, (value) => value.toString(16).padStart(2, '0')).join('');
}

function safeStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Kiosk storage may be disabled.
  }
}

function parseStoredConfig(raw: string | null): Partial<LiveBroadcastConfig> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<LiveBroadcastConfig>;
  } catch {
    return {};
  }
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

function normalizeText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : '';
}

function strings(value: unknown, maxItems = 160, maxLength = 120): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map((item) => normalizeText(item, maxLength))
    .filter(Boolean);
  return Array.from(new Set(normalized)).slice(0, maxItems);
}

function normalizeSnapshots(value: unknown): BroadcastPanelSnapshot[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const snapshots: BroadcastPanelSnapshot[] = [];
  for (const candidate of value.slice(0, 32)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const input = candidate as Partial<BroadcastPanelSnapshot>;
    const id = normalizeText(input.id, 100).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    snapshots.push({
      id,
      title: normalizeText(input.title, 140) || id,
      items: strings(input.items, 10, 260),
      updatedAt: Number.isFinite(Number(input.updatedAt)) ? Number(input.updatedAt) : Date.now(),
    });
  }
  return snapshots;
}

function normalizeMediaSources(value: unknown): BroadcastMediaSource[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const sources: BroadcastMediaSource[] = [];
  for (const candidate of value.slice(0, 16)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const input = candidate as Partial<BroadcastMediaSource>;
    const kind = input.kind === 'webcam' ? 'webcam' : 'channel';
    const id = normalizeText(input.id, 100).replace(/[^a-zA-Z0-9_-]/g, '');
    const key = `${kind}:${id}`;
    if (!id || seen.has(key)) continue;
    seen.add(key);
    const hlsUrl = normalizeText(input.hlsUrl, 700);
    const videoId = normalizeText(input.videoId, 32);
    const safeHls = /^https:\/\//i.test(hlsUrl) ? hlsUrl : undefined;
    const safeVideoId = /^[A-Za-z0-9_-]{6,20}$/.test(videoId) ? videoId : undefined;
    if (!safeHls && !safeVideoId) continue;
    sources.push({
      id,
      kind,
      name: normalizeText(input.name, 120) || id,
      ...(safeHls ? { hlsUrl: safeHls } : {}),
      ...(safeVideoId ? { videoId: safeVideoId } : {}),
    });
  }
  return sources;
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
    channelName: normalizeText(input.channelName, 80) || 'عين الصقر',
    channelSubtitle: normalizeText(input.channelSubtitle, 120) || 'قناة الأخبار والمعلومات والتحليل',
    panelIds: strings(input.panelIds, 120, 100),
    showMap: input.showMap !== false,
    columns,
    gapPx: Math.max(0, Math.min(24, Number(input.gapPx ?? 0))),
    tickerEnabled: input.tickerEnabled !== false,
    tickerSpeedSeconds: Math.max(15, Math.min(180, Number(input.tickerSpeedSeconds ?? 48))),
    tickerLimit: Math.max(5, Math.min(60, Number(input.tickerLimit ?? 24))),
    forceArabic: input.forceArabic !== false,
    translatePanelHeadlines: input.translatePanelHeadlines !== false,
    translationMode,
    ollamaUrl: normalizeText(input.ollamaUrl, 500).replace(/\/$/, '') || 'http://127.0.0.1:11434',
    ollamaModel: normalizeText(input.ollamaModel, 120) || 'qwen2.5:7b',
    liveChannelIds: strings(input.liveChannelIds, 80, 100),
    webcamIds: strings(input.webcamIds, 40, 100),
    mapLayerIds: strings(input.mapLayerIds, 120, 100),
    mediaColumns,
    showMediaWall: input.showMediaWall !== false,
    panelSnapshots: normalizeSnapshots(input.panelSnapshots),
    tickerHeadlines: strings(input.tickerHeadlines, 60, 320),
    mediaSources: normalizeMediaSources(input.mediaSources),
    projectionUpdatedAt: Number.isFinite(Number(input.projectionUpdatedAt)) ? Number(input.projectionUpdatedAt) : 0,
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
  url.pathname = '/broadcast/';
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
    try {
      subscriber(config);
    } catch (error) {
      console.warn('[عين الصقر] sync subscriber failed', error);
    }
  }
}

function storeAndDispatch(config: LiveBroadcastConfig): void {
  safeStorageSet(CONFIG_KEY, JSON.stringify(config));
  dispatchConfig(config);
}

function ensureListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  const station = getStationId();
  const bc = getChannel();
  bc?.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as { type?: string; station?: string; config?: Partial<LiveBroadcastConfig> };
    if (message?.type !== 'config' || message.station !== station || !message.config) return;
    storeAndDispatch(normalizeLiveConfig(message.config));
  });

  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== CONFIG_KEY || !event.newValue) return;
    storeAndDispatch(normalizeLiveConfig(parseStoredConfig(event.newValue)));
  });

  window.addEventListener('ayn-broadcast-config', (event: Event) => {
    const custom = event as CustomEvent<Partial<LiveBroadcastConfig>>;
    if (custom.detail) dispatchConfig(normalizeLiveConfig(custom.detail));
  });

  window.addEventListener('focus', () => void refreshRemoteConfig());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshRemoteConfig();
  });
}

async function pushRemote(config: LiveBroadcastConfig): Promise<void> {
  const station = getStationId();
  try {
    const response = await fetch(`/api/broadcast/state?station=${encodeURIComponent(station)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, controlKey: getControlKey() }),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { version?: number };
    lastRemoteVersion = Math.max(lastRemoteVersion, Number(payload.version || config.updatedAt));
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

export async function refreshRemoteConfig(): Promise<void> {
  if (remoteFetchRunning) return;
  remoteFetchRunning = true;
  const station = getStationId();
  try {
    const response = await fetch(`/api/broadcast/state?station=${encodeURIComponent(station)}&after=${lastRemoteVersion}`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (response.status === 204 || response.status === 404) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { config?: Partial<LiveBroadcastConfig>; version?: number };
    const version = Number(payload.version || payload.config?.updatedAt || 0);
    if (!payload.config || version <= lastRemoteVersion) return;
    lastRemoteVersion = version;
    const config = normalizeLiveConfig(payload.config);
    storeAndDispatch(config);
    announceStatus('online', 'وصل تحديث مباشر من غرفة التحكم');
  } catch {
    announceStatus('local', 'تعمل المزامنة المحلية؛ تعذر الوصول إلى خادم المحطة');
  } finally {
    remoteFetchRunning = false;
  }
}

export function subscribeLiveConfig(onConfig: (config: LiveBroadcastConfig) => void): () => void {
  ensureListeners();
  subscribers.add(onConfig);
  onConfig(loadLiveConfig());
  void refreshRemoteConfig();
  if (pollTimer === null) pollTimer = window.setInterval(() => void refreshRemoteConfig(), 1_000);

  return () => {
    subscribers.delete(onConfig);
    if (subscribers.size === 0 && pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };
}
