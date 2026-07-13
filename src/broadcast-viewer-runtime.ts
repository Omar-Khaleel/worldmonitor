import { DEFAULT_MAP_LAYERS } from '@/config';
import { OPTIONAL_LIVE_CHANNELS, getDefaultLiveChannels, type LiveChannel } from '@/components/LiveNewsPanel';
import { BROADCAST_WEBCAMS } from '@/broadcast-control-enhancements';
import { loadLiveConfig, subscribeLiveConfig, type LiveBroadcastConfig } from '@/broadcast-sync';

interface ManagedVideoElement extends HTMLVideoElement {
  __aynHls?: { destroy(): void };
}

let currentConfig: LiveBroadcastConfig | null = null;
let cleanupSubscription: (() => void) | null = null;
let mapApplyTimer: number | null = null;

function allChannels(): Map<string, LiveChannel> {
  const map = new Map<string, LiveChannel>();
  for (const channel of [...getDefaultLiveChannels(), ...OPTIONAL_LIVE_CHANNELS]) map.set(channel.id, channel);
  return map;
}

function hideElement(element: HTMLElement): void {
  element.style.setProperty('display', 'none', 'important');
  element.style.setProperty('visibility', 'hidden', 'important');
  element.style.setProperty('pointer-events', 'none', 'important');
  element.setAttribute('aria-hidden', 'true');
}

function hideViewerChrome(): void {
  const exactSelectors = [
    '.add-panel', '.add-panel-button', '.panel-add', '.add-widget', '.add-widget-button',
    '[data-action="add-panel"]', '[data-testid="add-panel"]', '.empty-panel-slot',
    '.dashboard-add-panel', '.panel-placeholder', '.resize-handle', '.panel-resize-handle',
  ];
  document.querySelectorAll<HTMLElement>(exactSelectors.join(',')).forEach(hideElement);

  document.querySelectorAll<HTMLElement>('button, [role="button"], .panel').forEach((element) => {
    const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
    if (/^(إضافة لوحة|أضف لوحة|Add panel|Add widget|\+)$/i.test(text)) hideElement(element);
  });
}

function applyPanels(config: LiveBroadcastConfig): void {
  const selected = new Set(config.panelIds);
  const panels = Array.from(document.querySelectorAll<HTMLElement>('#panelsGrid .panel[data-panel]'));
  for (const panel of panels) {
    if (panel.dataset.panel === 'ayn-media-wall') continue;
    const id = panel.dataset.panel || '';
    panel.classList.toggle('broadcast-panel-hidden', selected.length > 0 && !selected.has(id));
  }
  document.querySelector<HTMLElement>('#mapSection')?.classList.toggle('broadcast-panel-hidden', !config.showMap);
  document.documentElement.style.setProperty('--broadcast-columns', String(config.columns));
  document.documentElement.style.setProperty('--broadcast-gap', `${config.gapPx}px`);
}

function updateBrand(config: LiveBroadcastConfig): void {
  document.querySelector<HTMLElement>('.broadcast-channel-name')?.replaceChildren(config.channelName);
  document.querySelector<HTMLElement>('.broadcast-channel-subtitle')?.replaceChildren(config.channelSubtitle);
  document.querySelector<HTMLElement>('#broadcastChannelBug')?.setAttribute('aria-label', config.channelName);
  document.title = `${config.channelName} — بث مباشر`;
  const ticker = document.querySelector<HTMLElement>('#broadcastTicker');
  if (ticker) ticker.style.setProperty('display', config.tickerEnabled ? 'grid' : 'none', 'important');
}

function applyMapLayers(config: LiveBroadcastConfig): void {
  const selected = new Set(config.mapLayerIds);
  const layerState: Record<string, boolean> = {};
  for (const key of Object.keys(DEFAULT_MAP_LAYERS)) layerState[key] = selected.has(key);
  try {
    localStorage.setItem('worldmonitor-layers', JSON.stringify(layerState));
  } catch {
    // Storage may be disabled in kiosk mode.
  }

  const controls = document.querySelectorAll<HTMLElement>('[data-layer], [data-layer-key], input[name="map-layer"]');
  controls.forEach((element) => {
    const key = element.dataset.layer || element.dataset.layerKey || (element as HTMLInputElement).value || '';
    if (!key || !(key in layerState)) return;
    const wanted = layerState[key];
    if (element instanceof HTMLInputElement && element.type === 'checkbox') {
      if (element.checked !== wanted) element.click();
      return;
    }
    const pressed = element.getAttribute('aria-pressed');
    const active = pressed === 'true' || element.classList.contains('active') || element.classList.contains('enabled');
    if (active !== wanted) element.click();
  });
}

function youtubeEmbed(videoId: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  const origin = encodeURIComponent(window.location.origin);
  iframe.src = `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&rel=0&origin=${origin}`;
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.tabIndex = -1;
  iframe.setAttribute('aria-hidden', 'true');
  return iframe;
}

async function hlsVideo(url: string): Promise<ManagedVideoElement> {
  const video = document.createElement('video') as ManagedVideoElement;
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.controls = false;
  video.loop = false;
  video.setAttribute('disablepictureinpicture', '');

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
  } else {
    try {
      const module = await import('hls.js');
      const Hls = module.default;
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, lowLatencyMode: true, maxBufferLength: 20 });
        hls.loadSource(url);
        hls.attachMedia(video);
        video.dataset.aynHls = 'true';
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

function destroyMediaWall(): void {
  const wall = document.querySelector<HTMLElement>('#aynBroadcastMediaWall');
  wall?.querySelectorAll<ManagedVideoElement>('video').forEach((video) => {
    video.__aynHls?.destroy();
    video.pause();
    video.removeAttribute('src');
    video.load();
  });
  wall?.remove();
}

async function createSourceTile(name: string, hlsUrl?: string, videoId?: string): Promise<HTMLElement | null> {
  if (!hlsUrl && !videoId) return null;
  const tile = document.createElement('div');
  tile.className = 'ayn-media-tile';
  tile.setAttribute('aria-label', name);
  tile.title = '';
  const media = hlsUrl ? await hlsVideo(hlsUrl) : youtubeEmbed(videoId!);
  tile.appendChild(media);
  return tile;
}

async function renderMediaWall(config: LiveBroadcastConfig): Promise<void> {
  destroyMediaWall();
  if (!config.showMediaWall || (config.liveChannelIds.length === 0 && config.webcamIds.length === 0)) return;

  const grid = document.querySelector<HTMLElement>('#panelsGrid');
  if (!grid) return;
  const wall = document.createElement('section');
  wall.id = 'aynBroadcastMediaWall';
  wall.className = 'panel ayn-broadcast-media-wall';
  wall.dataset.panel = 'ayn-media-wall';
  wall.style.setProperty('--ayn-media-columns', String(config.mediaColumns));

  const channels = allChannels();
  const tiles: HTMLElement[] = [];
  for (const id of config.liveChannelIds.slice(0, 12)) {
    const channel = channels.get(id);
    if (!channel) continue;
    const tile = await createSourceTile(channel.name, channel.hlsUrl, channel.fallbackVideoId || channel.videoId);
    if (tile) tiles.push(tile);
  }
  for (const id of config.webcamIds.slice(0, 12)) {
    const webcam = BROADCAST_WEBCAMS.find((item) => item.id === id);
    if (!webcam) continue;
    const tile = await createSourceTile(`${webcam.city} ${webcam.country}`, undefined, webcam.fallbackVideoId);
    if (tile) tiles.push(tile);
  }

  if (tiles.length === 0) return;
  wall.append(...tiles);
  grid.prepend(wall);

  for (const id of ['live-news', 'live-webcams', 'windy-webcams']) {
    document.querySelector<HTMLElement>(`#panelsGrid .panel[data-panel='${id}']`)?.classList.add('broadcast-panel-hidden');
  }
}

async function applyConfig(config: LiveBroadcastConfig): Promise<void> {
  currentConfig = config;
  applyPanels(config);
  updateBrand(config);
  if (mapApplyTimer !== null) window.clearTimeout(mapApplyTimer);
  mapApplyTimer = window.setTimeout(() => applyMapLayers(config), 100);
  await renderMediaWall(config);
  hideViewerChrome();
  document.body.dataset.aynLiveConfigVersion = String(config.updatedAt);
  window.dispatchEvent(new CustomEvent('ayn-broadcast-viewer-applied', { detail: config }));
}

export function initBroadcastViewerRuntime(): void {
  const params = new URL(window.location.href).searchParams;
  if (params.get('broadcast') !== '1') return;
  if (document.body.dataset.aynViewerRuntime === '1') return;
  document.body.dataset.aynViewerRuntime = '1';

  void applyConfig(loadLiveConfig());
  cleanupSubscription?.();
  cleanupSubscription = subscribeLiveConfig((config) => void applyConfig(config));

  const observer = new MutationObserver(() => {
    hideViewerChrome();
    if (currentConfig) {
      applyPanels(currentConfig);
      updateBrand(currentConfig);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
