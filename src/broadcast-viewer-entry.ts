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
const MAP_LAYER_ALIASES: Record<string, string> = {
  conflicts: 'conflicts',
  natural: 'earthquakes',
  earthquakes: 'earthquakes',
  protests: 'protests',
  weather: 'weather',
  cables: 'cables',
  pipelines: 'pipelines',
  waterways: 'waterways',
  tradeRoutes: 'tradeRoutes',
  economic: 'economic',
  stockExchanges: 'stockExchanges',
  financialCenters: 'financialCenters',
  centralBanks: 'centralBanks',
  commodityHubs: 'commodityHubs',
  gulfInvestments: 'gulfInvestments',
};

let currentConfig = loadLiveConfig();
let fallbackHeadlines: string[] = [];
let fallbackTimer: number | null = null;
let mediaKey = '';
let mapKey = '';
let mapLoadTimer: number | null = null;
let clockTimer: number | null = null;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createShell(): {
  root: HTMLElement;
  channelName: HTMLElement;
  channelSubtitle: HTMLElement;
  state: HTMLElement;
  stateText: HTMLElement;
  mapSection: HTMLElement;
  mapWrap: HTMLElement;
  mediaSection: HTMLElement;
  mediaWall: HTMLElement;
  panelGrid: HTMLElement;
  ticker: HTMLElement;
  tickerTrack: HTMLElement;
  clock: HTMLTimeElement;
} {
  const root = document.getElementById('aynBroadcastViewer') || element('div');
  root.className = 'ayn-viewer-shell';
  root.replaceChildren();

  const header = element('header', 'ayn-viewer-header');
  const brand = element('div', 'ayn-viewer-brand');
  const mark = element('div', 'ayn-viewer-mark', '◉');
  const brandCopy = element('div', 'ayn-viewer-brand-copy');
  const channelName = element('strong', '', 'عين الصقر');
  const channelSubtitle = element('span', '', 'قناة الأخبار والمعلومات والتحليل');
  brandCopy.append(channelName, channelSubtitle);
  brand.append(mark, brandCopy);

  const state = element('div', 'ayn-viewer-state');
  state.dataset.state = 'connecting';
  const stateDot = element('span', 'ayn-viewer-state-dot');
  const stateText = element('span', '', `جارٍ الاتصال بالمحطة ${getStationId()}`);
  state.append(stateDot, stateText);
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
  return {
    root,
    channelName,
    channelSubtitle,
    state,
    stateText,
    mapSection,
    mapWrap,
    mediaSection,
    mediaWall,
    panelGrid,
    ticker,
    tickerTrack,
    clock,
  };
}

const ui = createShell();

function setState(state: 'online' | 'local' | 'error' | 'connecting', text: string): void {
  ui.state.dataset.state = state;
  ui.stateText.textContent = text;
}

function updateClock(): void {
  ui.clock.textContent = new Intl.DateTimeFormat('ar-IQ', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date());
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

function renderMap(config: LiveBroadcastConfig): void {
  ui.mapSection.hidden = !config.showMap;
  if (!config.showMap) {
    if (mapLoadTimer !== null) window.clearTimeout(mapLoadTimer);
    mapLoadTimer = null;
    ui.mapWrap.replaceChildren();
    mapKey = '';
    return;
  }

  const nextKey = JSON.stringify(config.mapLayerIds);
  if (nextKey === mapKey && ui.mapWrap.querySelector('iframe')) return;
  mapKey = nextKey;
  ui.mapWrap.replaceChildren();
  const placeholder = element('div', 'ayn-map-placeholder', 'جارٍ تحميل الخريطة بعد ظهور الأخبار...');
  ui.mapWrap.appendChild(placeholder);
  if (mapLoadTimer !== null) window.clearTimeout(mapLoadTimer);
  mapLoadTimer = window.setTimeout(() => {
    const frame = element('iframe', 'ayn-map-frame');
    frame.title = 'الخريطة العالمية المباشرة';
    frame.loading = 'lazy';
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.src = buildMapUrl(config);
    frame.addEventListener('load', () => { frame.dataset.ready = 'true'; }, { once: true });
    ui.mapWrap.prepend(frame);
  }, 900);
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
  frame.src = `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&rel=0`;
  frame.allow = 'autoplay; encrypted-media; picture-in-picture';
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.tabIndex = -1;
  frame.setAttribute('aria-hidden', 'true');
  return frame;
}

async function hlsVideo(url: string): Promise<ManagedVideoElement> {
  const video = element('video') as ManagedVideoElement;
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.controls = false;
  video.setAttribute('disablepictureinpicture', '');
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
  } else {
    try {
      const module = await import('hls.js');
      const Hls = module.default;
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, lowLatencyMode: true, maxBufferLength: 18 });
        hls.loadSource(url);
        hls.attachMedia(video);
        video.__aynHls = hls;
      } else {
        video.src = url;
      }
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
  const media = source.hlsUrl ? await hlsVideo(source.hlsUrl) : youtubeFrame(source.videoId!);
  tile.appendChild(media);
  return tile;
}

async function renderMedia(config: LiveBroadcastConfig): Promise<void> {
  const sources = config.showMediaWall ? config.mediaSources.slice(0, 12) : [];
  const nextKey = JSON.stringify(sources);
  ui.mediaSection.hidden = sources.length === 0;
  document.documentElement.style.setProperty('--ayn-media-columns', String(config.mediaColumns));
  if (nextKey === mediaKey) return;
  mediaKey = nextKey;
  destroyMedia();
  const tiles = await Promise.all(sources.map(createMediaTile));
  ui.mediaWall.append(...tiles.filter((tile): tile is HTMLElement => Boolean(tile)));
}

function renderSnapshots(snapshots: BroadcastPanelSnapshot[]): void {
  const previous = new Map(
    Array.from(ui.panelGrid.querySelectorAll<HTMLElement>('.ayn-panel-card[data-panel-id]'))
      .map((card) => [card.dataset.panelId || '', card]),
  );
  const fragment = document.createDocumentFragment();

  for (const snapshot of snapshots) {
    let card = previous.get(snapshot.id);
    if (!card) {
      card = element('article', 'ayn-panel-card');
      card.dataset.panelId = snapshot.id;
    }
    card.replaceChildren();
    const title = element('h2', '', snapshot.title);
    const list = element('ul');
    const items = snapshot.items.length > 0 ? snapshot.items : ['بانتظار تحديث بيانات هذه اللوحة من غرفة التحكم.'];
    items.slice(0, 10).forEach((item) => list.appendChild(element('li', '', item)));
    card.append(title, list);
    fragment.appendChild(card);
    previous.delete(snapshot.id);
  }

  ui.panelGrid.replaceChildren(fragment);
  if (snapshots.length === 0) {
    ui.panelGrid.appendChild(element('div', 'ayn-panel-empty', 'بانتظار إرسال الأخبار وبيانات اللوحات من غرفة التحكم...'));
  }
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
  const content = headlines.length > 0
    ? headlines
    : ['جارٍ جمع الأخبار العالمية وربطها بغرفة التحكم...'];
  ui.tickerTrack.replaceChildren();
  for (const headline of [...content, ...content]) {
    const item = element('span', 'ayn-ticker-item');
    item.append(element('b', '', '◆'), element('span', '', headline));
    ui.tickerTrack.appendChild(item);
  }
  const duration = Math.max(config.tickerSpeedSeconds, Math.min(180, content.length * 5));
  ui.tickerTrack.style.setProperty('--ayn-ticker-duration', `${duration}s`);
}

async function fetchFeed(url: string): Promise<string[]> {
  const response = await fetch(`/api/rss-proxy?url=${encodeURIComponent(url)}`, { cache: 'no-store' });
  if (!response.ok) return [];
  const xml = await response.text();
  const documentXml = new DOMParser().parseFromString(xml, 'application/xml');
  return Array.from(documentXml.querySelectorAll('item > title, entry > title'))
    .map((node) => node.textContent?.replace(/\s+/g, ' ').trim() || '')
    .filter(Boolean)
    .slice(0, 12);
}

async function refreshFallbackHeadlines(): Promise<void> {
  try {
    const batches = await Promise.all(FALLBACK_FEEDS.map(fetchFeed));
    const raw = uniqueHeadlines(batches.flat(), Math.max(currentConfig.tickerLimit, 20));
    fallbackHeadlines = await translateBroadcastStrings(raw, currentConfig, 30);
    renderTicker(currentConfig);
  } catch {
    // The projected headlines from control remain the primary source.
  }
}

async function applyConfig(config: LiveBroadcastConfig): Promise<void> {
  currentConfig = config;
  document.documentElement.style.setProperty('--ayn-columns', String(config.columns));
  document.documentElement.style.setProperty('--ayn-gap', `${config.gapPx}px`);
  ui.channelName.textContent = config.channelName;
  ui.channelSubtitle.textContent = config.channelSubtitle;
  document.title = `${config.channelName} — بث مباشر`;
  renderMap(config);
  renderSnapshots(config.panelSnapshots);
  renderTicker(config);
  await renderMedia(config);
  const age = config.projectionUpdatedAt > 0 ? Math.round((Date.now() - config.projectionUpdatedAt) / 1_000) : null;
  setState('online', age === null ? `متصل بالمحطة ${getStationId()}` : `متصل — آخر تحديث قبل ${Math.max(0, age)} ثانية`);
}

window.addEventListener('ayn-broadcast-sync-status', (event) => {
  const detail = (event as CustomEvent<{ state?: string; detail?: string }>).detail;
  if (detail?.state === 'online') {
    setState('online', detail.detail || 'متصل بغرفة التحكم');
  } else {
    setState('local', 'المزامنة المحلية فعالة — إعادة محاولة الاتصال بالخادم');
  }
});

subscribeLiveConfig((config) => void applyConfig(config));
void refreshRemoteConfig();
void refreshFallbackHeadlines();
window.setTimeout(() => void refreshFallbackHeadlines(), 5_000);
if (fallbackTimer !== null) window.clearInterval(fallbackTimer);
fallbackTimer = window.setInterval(() => void refreshFallbackHeadlines(), 60_000);
updateClock();
if (clockTimer !== null) window.clearInterval(clockTimer);
clockTimer = window.setInterval(updateClock, 1_000);

if ('caches' in window) {
  void caches.delete('html-navigation').catch(() => {});
}
