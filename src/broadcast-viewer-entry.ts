import '@/styles/broadcast-viewer-lite.css';
import {
  getStationId,
  loadLiveConfig,
  refreshRemoteConfig,
  subscribeLiveConfig,
  type BroadcastMediaSource,
  type BroadcastPanelSnapshot,
  type LiveBroadcastConfig,
} from '@/broadcast-sync';
import { translateBroadcastStrings } from '@/broadcast-translator';

interface ManagedVideoElement extends HTMLVideoElement {
  __aynHls?: { destroy(): void };
}

const FALLBACK_FEEDS = [
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://www.aljazeera.com/xml/rss/all.xml',
  'https://news.un.org/feed/subscribe/en/news/all/rss.xml',
];
const MAX_MEDIA_SOURCES = 6;
const MAX_VISIBLE_PANELS = 12;
const MAX_PANEL_ITEMS = 6;
const MAP_LAYER_ALIASES: Record<string, string> = {
  conflicts: 'conflicts', natural: 'earthquakes', earthquakes: 'earthquakes', protests: 'protests',
  weather: 'weather', cables: 'cables', pipelines: 'pipelines', waterways: 'waterways',
  tradeRoutes: 'tradeRoutes', economic: 'economic', stockExchanges: 'stockExchanges',
  financialCenters: 'financialCenters', centralBanks: 'centralBanks', commodityHubs: 'commodityHubs',
  gulfInvestments: 'gulfInvestments',
};

let currentConfig = loadLiveConfig();
let fallbackHeadlines: string[] = [];
let mediaTimer: number | null = null;
let mapTimer: number | null = null;
let mediaKey = '';
let mediaGeneration = 0;
let mapKey = '';
let fallbackRequestRunning = false;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createShell() {
  const root = document.getElementById('aynBroadcastViewer') || element('div');
  root.className = 'ayn-viewer-shell';
  root.replaceChildren();

  const header = element('header', 'ayn-viewer-header');
  const brand = element('div', 'ayn-viewer-brand');
  const copy = element('div', 'ayn-viewer-brand-copy');
  const channelName = element('strong', '', 'عين الصقر');
  const channelSubtitle = element('span', '', 'قناة الأخبار والمعلومات والتحليل');
  copy.append(channelName, channelSubtitle);
  brand.append(element('div', 'ayn-viewer-mark', '◉'), copy);
  const state = element('div', 'ayn-viewer-state');
  state.dataset.state = 'connecting';
  const stateText = element('span', '', `جارٍ الاتصال بالمحطة ${getStationId()}`);
  state.append(element('span', 'ayn-viewer-state-dot'), stateText);
  header.append(brand, state);

  const main = element('main', 'ayn-viewer-main');
  const mediaSection = element('section', 'ayn-section');
  mediaSection.hidden = true;
  const mediaLabel = element('div', 'ayn-section-label');
  mediaLabel.append(element('span', '', 'البث المباشر'), element('time', '', 'LIVE'));
  const mediaWall = element('div', 'ayn-media-wall');
  mediaSection.append(mediaLabel, mediaWall);

  const mapSection = element('section', 'ayn-section');
  mapSection.hidden = true;
  const mapLabel = element('div', 'ayn-section-label');
  mapLabel.append(element('span', '', 'الخريطة العالمية المباشرة'), element('time', '', 'تحديث حي'));
  const mapWrap = element('div', 'ayn-map-frame-wrap');
  mapSection.append(mapLabel, mapWrap);

  const panelGrid = element('section', 'ayn-panel-grid');
  main.append(mediaSection, mapSection, panelGrid);

  const ticker = element('footer', 'ayn-ticker');
  const tickerLabel = element('div', 'ayn-ticker-label');
  tickerLabel.append(element('span', 'ayn-ticker-pulse'), element('strong', '', 'آخر الأخبار'));
  const tickerViewport = element('div', 'ayn-ticker-viewport');
  const tickerTrack = element('div', 'ayn-ticker-track');
  tickerViewport.appendChild(tickerTrack);
  const clock = element('time', 'ayn-ticker-clock');
  ticker.append(tickerLabel, tickerViewport, clock);
  root.append(header, main, ticker);

  return { channelName, channelSubtitle, state, stateText, mediaSection, mediaWall, mapSection, mapWrap, panelGrid, ticker, tickerTrack, clock };
}

const ui = createShell();

function setState(state: 'online' | 'local' | 'error' | 'connecting', text: string): void {
  ui.state.dataset.state = state;
  ui.stateText.textContent = text;
}

function updateClock(): void {
  ui.clock.textContent = new Intl.DateTimeFormat('ar-IQ', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
}

function uniqueHeadlines(values: readonly string[], limit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of values) {
    const value = raw.replace(/\s+/g, ' ').trim();
    const key = value.toLocaleLowerCase();
    if (value.length < 12 || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
    if (output.length >= limit) break;
  }
  return output;
}

function renderTicker(config: LiveBroadcastConfig): void {
  ui.ticker.hidden = !config.tickerEnabled;
  if (!config.tickerEnabled) return;
  const headlines = uniqueHeadlines([...config.tickerHeadlines, ...fallbackHeadlines], config.tickerLimit);
  const content = headlines.length > 0 ? headlines : ['جارٍ جلب آخر الأخبار من المصادر العالمية...'];
  const fingerprint = content.join('\u0001');
  if (ui.tickerTrack.dataset.fingerprint === fingerprint) return;
  ui.tickerTrack.dataset.fingerprint = fingerprint;
  ui.tickerTrack.replaceChildren();
  for (const headline of [...content, ...content]) {
    const item = element('span', 'ayn-ticker-item');
    item.append(element('b', '', '◆'), element('span', '', headline));
    ui.tickerTrack.appendChild(item);
  }
  const duration = Math.max(config.tickerSpeedSeconds, Math.min(180, content.length * 5));
  ui.tickerTrack.style.setProperty('--ayn-ticker-duration', `${duration}s`);
}

function renderSnapshots(snapshots: BroadcastPanelSnapshot[]): void {
  const fragment = document.createDocumentFragment();
  for (const snapshot of snapshots.slice(0, MAX_VISIBLE_PANELS)) {
    const card = element('article', 'ayn-panel-card');
    card.dataset.panelId = snapshot.id;
    const list = element('ul');
    const items = snapshot.items.length > 0 ? snapshot.items : ['بانتظار وصول بيانات هذه اللوحة.'];
    for (const item of items.slice(0, MAX_PANEL_ITEMS)) list.appendChild(element('li', '', item));
    card.append(element('h2', '', snapshot.title), list);
    fragment.appendChild(card);
  }
  ui.panelGrid.replaceChildren(fragment);
  if (snapshots.length === 0) {
    ui.panelGrid.appendChild(element('div', 'ayn-panel-empty', 'بانتظار إرسال الأخبار والبيانات من غرفة التحكم...'));
  }
}

function buildMapUrl(config: LiveBroadcastConfig): string {
  const ids = Array.from(new Set(config.mapLayerIds.map((id) => MAP_LAYER_ALIASES[id]).filter(Boolean)));
  const url = new URL('/embed.html', window.location.origin);
  url.searchParams.set('layers', ids.length > 0 ? ids.join(',') : 'conflicts,earthquakes,weather');
  url.searchParams.set('center', '20,0');
  url.searchParams.set('zoom', '1');
  url.searchParams.set('theme', 'dark');
  url.searchParams.set('variant', 'full');
  return url.toString();
}

function scheduleMap(config: LiveBroadcastConfig): void {
  ui.mapSection.hidden = !config.showMap;
  if (!config.showMap) {
    if (mapTimer !== null) window.clearTimeout(mapTimer);
    ui.mapWrap.replaceChildren();
    mapKey = '';
    return;
  }
  const nextKey = JSON.stringify(config.mapLayerIds);
  if (nextKey === mapKey && ui.mapWrap.querySelector('iframe')) return;
  mapKey = nextKey;
  ui.mapWrap.replaceChildren(element('div', 'ayn-map-placeholder', 'جارٍ تجهيز الخريطة...'));
  if (mapTimer !== null) window.clearTimeout(mapTimer);
  mapTimer = window.setTimeout(() => {
    const frame = element('iframe', 'ayn-map-frame');
    frame.title = 'الخريطة العالمية المباشرة';
    frame.loading = 'lazy';
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.src = buildMapUrl(config);
    ui.mapWrap.replaceChildren(frame);
  }, 2_500);
}

function destroyMedia(): void {
  ui.mediaWall.querySelectorAll<ManagedVideoElement>('video').forEach((video) => {
    video.__aynHls?.destroy();
    video.pause();
    video.removeAttribute('src');
    video.load();
  });
  ui.mediaWall.replaceChildren();
}

function youtubeFrame(videoId: string): HTMLIFrameElement {
  const frame = element('iframe');
  frame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&rel=0`;
  frame.allow = 'autoplay; encrypted-media; picture-in-picture';
  frame.loading = 'lazy';
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.tabIndex = -1;
  return frame;
}

async function hlsVideo(url: string): Promise<ManagedVideoElement> {
  const video = element('video') as ManagedVideoElement;
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.controls = false;
  video.preload = 'metadata';
  video.setAttribute('disablepictureinpicture', '');
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
  } else {
    try {
      const { default: Hls } = await import('hls.js');
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 8, backBufferLength: 0 });
        hls.loadSource(url);
        hls.attachMedia(video);
        video.__aynHls = hls;
      } else video.src = url;
    } catch {
      video.src = url;
    }
  }
  void video.play().catch(() => {});
  return video;
}

async function createMediaTile(source: BroadcastMediaSource): Promise<HTMLElement | null> {
  if (!source.hlsUrl && !source.videoId) return null;
  const tile = element('div', 'ayn-media-tile');
  tile.setAttribute('aria-label', source.name);
  tile.appendChild(source.hlsUrl ? await hlsVideo(source.hlsUrl) : youtubeFrame(source.videoId!));
  return tile;
}

async function renderMedia(config: LiveBroadcastConfig): Promise<void> {
  const sources = config.showMediaWall ? config.mediaSources.slice(0, MAX_MEDIA_SOURCES) : [];
  const nextKey = JSON.stringify(sources);
  ui.mediaSection.hidden = sources.length === 0;
  document.documentElement.style.setProperty('--ayn-media-columns', String(Math.min(config.mediaColumns, 3)));
  if (nextKey === mediaKey) return;
  mediaKey = nextKey;
  const generation = ++mediaGeneration;
  destroyMedia();
  const tiles = await Promise.all(sources.map(createMediaTile));
  if (generation !== mediaGeneration) return;
  ui.mediaWall.append(...tiles.filter((tile): tile is HTMLElement => Boolean(tile)));
}

function scheduleMedia(config: LiveBroadcastConfig): void {
  if (mediaTimer !== null) window.clearTimeout(mediaTimer);
  mediaTimer = window.setTimeout(() => void renderMedia(config), 1_200);
}

async function fetchFeed(url: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`/api/rss-proxy?url=${encodeURIComponent(url)}`, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return [];
    const xml = await response.text();
    const documentXml = new DOMParser().parseFromString(xml, 'application/xml');
    return Array.from(documentXml.querySelectorAll('item > title, entry > title'))
      .map((node) => node.textContent?.replace(/\s+/g, ' ').trim() || '')
      .filter(Boolean)
      .slice(0, 10);
  } catch {
    return [];
  } finally {
    window.clearTimeout(timer);
  }
}

function projectedHeadlinesAreFresh(config: LiveBroadcastConfig): boolean {
  return config.tickerHeadlines.length >= 3
    && config.projectionUpdatedAt > 0
    && Date.now() - config.projectionUpdatedAt < 120_000;
}

async function refreshFallbackHeadlines(): Promise<void> {
  if (fallbackRequestRunning || projectedHeadlinesAreFresh(currentConfig)) return;
  fallbackRequestRunning = true;
  try {
    const raw = uniqueHeadlines((await Promise.all(FALLBACK_FEEDS.map(fetchFeed))).flat(), Math.max(currentConfig.tickerLimit, 20));
    if (raw.length === 0) return;
    fallbackHeadlines = raw;
    renderTicker(currentConfig);
    const translated = await translateBroadcastStrings(raw, currentConfig, 30);
    if (translated.length > 0) {
      fallbackHeadlines = translated;
      renderTicker(currentConfig);
    }
  } finally {
    fallbackRequestRunning = false;
  }
}

async function applyConfig(config: LiveBroadcastConfig): Promise<void> {
  currentConfig = config;
  document.documentElement.style.setProperty('--ayn-columns', String(Math.min(config.columns, 3)));
  document.documentElement.style.setProperty('--ayn-gap', `${config.gapPx}px`);
  ui.channelName.textContent = config.channelName;
  ui.channelSubtitle.textContent = config.channelSubtitle;
  document.title = `${config.channelName} — بث مباشر`;
  renderSnapshots(config.panelSnapshots);
  renderTicker(config);
  scheduleMap(config);
  scheduleMedia(config);
  const age = config.projectionUpdatedAt > 0 ? Math.round((Date.now() - config.projectionUpdatedAt) / 1_000) : null;
  setState('online', age === null ? `متصل بالمحطة ${getStationId()}` : `متصل — آخر تحديث قبل ${Math.max(0, age)} ثانية`);
  if (!projectedHeadlinesAreFresh(config)) void refreshFallbackHeadlines();
}

window.addEventListener('ayn-broadcast-sync-status', (event) => {
  const detail = (event as CustomEvent<{ state?: string; detail?: string }>).detail;
  if (detail?.state === 'online') setState('online', detail.detail || 'متصل بغرفة التحكم');
  else setState('local', 'إعادة محاولة الاتصال بغرفة التحكم...');
});

subscribeLiveConfig((config) => void applyConfig(config));
void refreshRemoteConfig();
window.setTimeout(() => void refreshFallbackHeadlines(), 500);
window.setInterval(() => void refreshFallbackHeadlines(), 60_000);
updateClock();
window.setInterval(updateClock, 1_000);

if ('caches' in window) {
  void Promise.all([
    caches.delete('html-navigation'),
    caches.delete('workbox-precache-v2'),
  ]).catch(() => {});
}
