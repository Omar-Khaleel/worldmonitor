import './styles/broadcast-station-hotfix.css';

const BROADCAST_STORAGE_KEY = 'ayn-al-saqr-broadcast-config-v1';
const URL_CONFIG_KEY = 'bcfg';

interface DefaultBroadcastConfig {
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
  translationMode: 'server' | 'ollama' | 'off';
  ollamaUrl: string;
  ollamaModel: string;
  liveChannelIds: string[];
  webcamIds: string[];
  mapLayerIds: string[];
  mediaColumns: 1 | 2 | 3 | 4;
  showMediaWall: boolean;
}

async function waitForDashboardPanels(timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const grid = document.querySelector('#panelsGrid');
    const panelCount = document.querySelectorAll('#panelsGrid .panel[data-panel]').length;
    if (grid && panelCount > 0) return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
  }
}

function getAvailablePanelIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('#panelsGrid .panel[data-panel]'))
    .map((panel) => panel.dataset.panel || '')
    .filter(Boolean);
}

function selectDefaultViewerPanels(): string[] {
  const available = new Set(getAvailablePanelIds());
  const preferred = [
    'insights',
    'strategic-posture',
    'cii',
    'strategic-risk',
    'intel',
    'gdelt-intel',
    'politics',
    'threat-timeline',
  ];
  const selected = preferred.filter((id) => available.has(id)).slice(0, 6);
  if (selected.length >= 4) return selected;

  const positive = /insight|intelligence|intel|analysis|strategic|risk|politic|world|news|threat|crisis|تحليل|استخبار|سياس|عالم|أخبار|مخاطر|تهديد/i;
  const negative = /live-news|live-webcams|windy-webcams|webcam|camera|video|stream|clock|weather|flight|ship/i;
  const fallback = Array.from(document.querySelectorAll<HTMLElement>('#panelsGrid .panel[data-panel]'))
    .map((panel, order) => {
      const id = panel.dataset.panel || '';
      const title = panel.querySelector<HTMLElement>('.panel-title')?.textContent || '';
      const text = `${id} ${title}`;
      const score = (positive.test(text) ? 20 : 0) - (negative.test(text) ? 100 : 0);
      return { id, score, order };
    })
    .filter((item) => item.id && item.score >= 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((item) => item.id);

  return Array.from(new Set([...selected, ...fallback])).slice(0, 6);
}

function ensureDefaultViewerConfig(params: URLSearchParams): void {
  if (params.get('broadcast') !== '1' || params.has(URL_CONFIG_KEY)) return;

  let existing: Partial<DefaultBroadcastConfig> = {};
  try {
    existing = JSON.parse(localStorage.getItem(BROADCAST_STORAGE_KEY) || '{}') as Partial<DefaultBroadcastConfig>;
  } catch {
    existing = {};
  }

  const config: DefaultBroadcastConfig = {
    version: 2,
    updatedAt: Number(existing.updatedAt || Date.now()),
    channelName: existing.channelName || 'عين الصقر',
    channelSubtitle: existing.channelSubtitle || 'قناة الأخبار والمعلومات والتحليل',
    panelIds: existing.panelIds?.length ? existing.panelIds : selectDefaultViewerPanels(),
    showMap: existing.showMap !== false,
    columns: existing.columns || 3,
    gapPx: Number(existing.gapPx ?? 0),
    tickerEnabled: existing.tickerEnabled !== false,
    tickerSpeedSeconds: Number(existing.tickerSpeedSeconds ?? 48),
    tickerLimit: Number(existing.tickerLimit ?? 24),
    forceArabic: true,
    translatePanelHeadlines: existing.translatePanelHeadlines !== false,
    translationMode: existing.translationMode || 'ollama',
    ollamaUrl: existing.ollamaUrl || 'http://127.0.0.1:11434',
    ollamaModel: existing.ollamaModel || 'qwen2.5:7b',
    liveChannelIds: existing.liveChannelIds || ['alarabiya', 'aljazeera-arabic'],
    webcamIds: existing.webcamIds || ['jerusalem', 'middle-east'],
    mapLayerIds: existing.mapLayerIds || ['conflicts', 'hotspots', 'sanctions', 'weather', 'military', 'natural'],
    mediaColumns: existing.mediaColumns || 2,
    showMediaWall: existing.showMediaWall !== false,
  };

  try {
    localStorage.setItem(BROADCAST_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // A hardened browser may disable storage; broadcast-station still has internal defaults.
  }
}

function forceControlActionsVisible(): void {
  const room = document.querySelector<HTMLElement>('#broadcastControlRoom');
  const body = room?.querySelector<HTMLElement>('.broadcast-control-body');
  const status = room?.querySelector<HTMLElement>('.broadcast-control-status');
  const actions = room?.querySelector<HTMLElement>('.broadcast-control-actions');
  if (!room || !actions) return;

  room.style.setProperty('display', 'flex', 'important');
  room.style.setProperty('flex-direction', 'column', 'important');
  room.style.setProperty('height', '100dvh', 'important');
  room.style.setProperty('overflow', 'hidden', 'important');

  body?.style.setProperty('flex', '1 1 auto', 'important');
  body?.style.setProperty('min-height', '0', 'important');
  body?.style.setProperty('overflow-y', 'auto', 'important');

  status?.style.setProperty('display', 'block', 'important');
  status?.style.setProperty('visibility', 'visible', 'important');
  status?.style.setProperty('opacity', '1', 'important');

  actions.style.setProperty('display', 'grid', 'important');
  actions.style.setProperty('visibility', 'visible', 'important');
  actions.style.setProperty('opacity', '1', 'important');
  actions.style.setProperty('pointer-events', 'auto', 'important');
  actions.style.setProperty('flex', '0 0 auto', 'important');

  actions.querySelectorAll<HTMLElement>('button').forEach((button) => {
    button.style.setProperty('display', 'block', 'important');
    button.style.setProperty('visibility', 'visible', 'important');
    button.style.setProperty('opacity', '1', 'important');
    button.style.setProperty('pointer-events', 'auto', 'important');
  });
}

export async function initBroadcastStationWhenReady(): Promise<void> {
  await waitForDashboardPanels();
  const params = new URL(window.location.href).searchParams;
  ensureDefaultViewerConfig(params);

  const module = await import('@/broadcast-station');
  module.prepareBroadcastLanguage();
  await module.initBroadcastStation();

  if (params.get('control') === '1') {
    forceControlActionsVisible();
    window.setTimeout(forceControlActionsVisible, 500);
    const control = await import('@/broadcast-control-enhancements');
    control.initBroadcastControlEnhancements();
  }

  if (params.get('broadcast') === '1') {
    const [translation, polish, runtime, newsWire] = await Promise.all([
      import('@/broadcast-translation-hotfix'),
      import('@/broadcast-viewer-polish'),
      import('@/broadcast-viewer-runtime'),
      import('@/broadcast-news-wire-v2'),
    ]);
    translation.initBroadcastTranslationHotfix();
    polish.initBroadcastViewerPolish();
    runtime.initBroadcastViewerRuntime();
    newsWire.initBroadcastNewsWireV2();
  }
}
