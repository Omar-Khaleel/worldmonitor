import { OPTIONAL_LIVE_CHANNELS, getDefaultLiveChannels, type LiveChannel } from '@/components/LiveNewsPanel';
import { BROADCAST_WEBCAMS } from '@/broadcast-control-enhancements';
import {
  loadLiveConfig,
  publishLiveConfig,
  type BroadcastMediaSource,
  type BroadcastPanelSnapshot,
  type LiveBroadcastConfig,
} from '@/broadcast-sync';
import { translateBroadcastStrings } from '@/broadcast-translator';

const NEWS_SELECTOR = [
  '[data-headline]', '.item-title', '.news-item-title', '.news-title', '.headline',
  '.article-title', '.story-title', '.feed-item-title', '.panel-summary-text',
  'article h3', 'article h4',
].join(',');
const ITEM_SELECTOR = [
  NEWS_SELECTOR, '.item-snippet', '.news-summary', '.article-summary', '.metric-value',
  '.stat-value', '.status-value', '.panel-content li', '.panel-content article',
].join(',');

let heartbeatTimer: number | null = null;
let debounceTimer: number | null = null;
let observer: MutationObserver | null = null;
let projectionRunning = false;
let rerunRequested = false;
let lastFingerprint = '';
let activeFingerprint = '';

function normalize(value: string, maxLength = 260): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function isUseful(value: string): boolean {
  if (value.length < 4) return false;
  if (/^(loading|retry|read more|view all|show more|live|source|مباشر|المزيد|عرض الكل|جارٍ التحميل|لا توجد بيانات)$/i.test(value)) return false;
  return true;
}

function panelScore(panel: HTMLElement): number {
  const id = panel.dataset.panel || '';
  const title = panel.querySelector<HTMLElement>('.panel-title')?.textContent || '';
  const text = `${id} ${title}`.toLowerCase();
  let score = 0;
  if (/politics|world|government|middleeast|europe|asia|africa|latam|news/.test(text)) score += 160;
  if (/intel|insight|strategic|threat|risk|conflict|crisis|security|sanction/.test(text)) score += 130;
  if (/market|economic|energy|trade|technology|climate/.test(text)) score += 70;
  if (/webcam|camera|live-news|stream|video/.test(text)) score -= 200;
  return score;
}

function textCandidates(root: ParentNode, selector: string, limit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  root.querySelectorAll<HTMLElement>(selector).forEach((node) => {
    if (output.length >= limit) return;
    if (node.closest('button, select, option, input, textarea, nav, [role="tablist"]')) return;
    const original = node.dataset.aynOriginal || node.dataset.broadcastOriginal || node.dataset.original || node.textContent || '';
    const value = normalize(original);
    const key = value.toLocaleLowerCase();
    if (!isUseful(value) || seen.has(key)) return;
    seen.add(key);
    output.push(value);
  });
  return output;
}

function selectedPanelIds(room: HTMLElement, config: LiveBroadcastConfig): string[] {
  const selected = Array.from(room.querySelectorAll<HTMLInputElement>("input[id^='broadcast-panel-']:checked"))
    .map((input) => input.id.replace('broadcast-panel-', ''));
  return selected.length > 0 ? selected : config.panelIds;
}

function collectSnapshots(room: HTMLElement, config: LiveBroadcastConfig): BroadcastPanelSnapshot[] {
  const selected = new Set(selectedPanelIds(room, config));
  const panels = Array.from(document.querySelectorAll<HTMLElement>('#panelsGrid .panel[data-panel]'));
  const snapshots: BroadcastPanelSnapshot[] = [];

  for (const panel of panels) {
    const id = panel.dataset.panel || '';
    if (!id || !selected.has(id) || /live-news|live-webcams|windy-webcams/.test(id)) continue;
    const title = normalize(panel.querySelector<HTMLElement>('.panel-title')?.textContent || id, 140);
    let items = textCandidates(panel, ITEM_SELECTOR, 10).filter((item) => item !== title);
    if (items.length === 0) {
      const raw = normalize(panel.querySelector<HTMLElement>('.panel-content')?.textContent || '', 1_800);
      items = raw.split(/(?<=[.!?؟])\s+|\s*[•|]\s*/).map((value) => normalize(value)).filter(isUseful).slice(0, 8);
    }
    snapshots.push({ id, title, items, updatedAt: Date.now() });
    if (snapshots.length >= 24) break;
  }
  return snapshots;
}

function collectHeadlines(config: LiveBroadcastConfig): string[] {
  const candidates: Array<{ text: string; score: number; order: number }> = [];
  const seen = new Set<string>();
  let order = 0;
  document.querySelectorAll<HTMLElement>('#panelsGrid .panel[data-panel]').forEach((panel) => {
    const score = panelScore(panel);
    textCandidates(panel, NEWS_SELECTOR, 18).forEach((text) => {
      if (text.length < 14) return;
      const key = text.toLocaleLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ text, score, order: order++ });
    });
  });
  candidates.sort((left, right) => right.score - left.score || left.order - right.order);
  return candidates.slice(0, Math.max(config.tickerLimit * 2, 30)).map((candidate) => candidate.text);
}

function channelMap(): Map<string, LiveChannel> {
  const channels = new Map<string, LiveChannel>();
  for (const channel of [...getDefaultLiveChannels(), ...OPTIONAL_LIVE_CHANNELS]) channels.set(channel.id, channel);
  return channels;
}

function checkedValues(room: HTMLElement, group: string): string[] {
  return Array.from(room.querySelectorAll<HTMLInputElement>(`input[data-ayn-group='${group}']:checked`))
    .map((input) => input.value || input.id.replace(`ayn-${group}-`, ''));
}

function collectMediaSources(room: HTMLElement, config: LiveBroadcastConfig): BroadcastMediaSource[] {
  const selectedChannels = checkedValues(room, 'channel');
  const selectedWebcams = checkedValues(room, 'webcam');
  const channelIds = selectedChannels.length > 0 ? selectedChannels : config.liveChannelIds;
  const webcamIds = selectedWebcams.length > 0 ? selectedWebcams : config.webcamIds;
  const channels = channelMap();
  const sources: BroadcastMediaSource[] = [];

  for (const id of channelIds.slice(0, 12)) {
    const channel = channels.get(id);
    if (!channel) continue;
    const videoId = channel.fallbackVideoId || channel.videoId;
    if (!channel.hlsUrl && !videoId) continue;
    sources.push({
      id,
      kind: 'channel',
      name: channel.name,
      ...(channel.hlsUrl ? { hlsUrl: channel.hlsUrl } : {}),
      ...(videoId ? { videoId } : {}),
    });
  }
  for (const id of webcamIds.slice(0, 12)) {
    const webcam = BROADCAST_WEBCAMS.find((candidate) => candidate.id === id);
    if (!webcam?.fallbackVideoId) continue;
    sources.push({
      id,
      kind: 'webcam',
      name: `${webcam.city} — ${webcam.country}`,
      videoId: webcam.fallbackVideoId,
    });
  }
  return sources.slice(0, 16);
}

function fingerprintProjection(
  snapshots: BroadcastPanelSnapshot[],
  headlines: string[],
  mediaSources: BroadcastMediaSource[],
  config: LiveBroadcastConfig,
): string {
  return JSON.stringify({
    snapshots: snapshots.map(({ id, title, items }) => ({ id, title, items })),
    headlines,
    mediaSources,
    panelIds: config.panelIds,
    showMap: config.showMap,
    mapLayerIds: config.mapLayerIds,
  });
}

async function translateProjection(
  snapshots: BroadcastPanelSnapshot[],
  headlines: string[],
  config: LiveBroadcastConfig,
): Promise<{ snapshots: BroadcastPanelSnapshot[]; headlines: string[] }> {
  const strings: string[] = [...headlines];
  if (config.translatePanelHeadlines) {
    for (const snapshot of snapshots) strings.push(snapshot.title, ...snapshot.items);
  }
  const translated = await translateBroadcastStrings(strings, config, 100);
  let cursor = 0;
  const translatedHeadlines = translated.slice(cursor, cursor + headlines.length);
  cursor += headlines.length;
  if (!config.translatePanelHeadlines) return { snapshots, headlines: translatedHeadlines };

  const translatedSnapshots = snapshots.map((snapshot) => {
    const title = translated[cursor++] || snapshot.title;
    const items = snapshot.items.map((item) => translated[cursor++] || item);
    return { ...snapshot, title, items, updatedAt: Date.now() };
  });
  return { snapshots: translatedSnapshots, headlines: translatedHeadlines };
}

async function publishProjection(room: HTMLElement, force = false): Promise<void> {
  if (projectionRunning) {
    rerunRequested = true;
    return;
  }
  projectionRunning = true;
  try {
    const config = loadLiveConfig();
    const snapshots = collectSnapshots(room, config);
    const headlines = collectHeadlines(config);
    const mediaSources = collectMediaSources(room, config);
    const fingerprint = fingerprintProjection(snapshots, headlines, mediaSources, config);
    if (!force && fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    activeFingerprint = fingerprint;

    publishLiveConfig({
      panelSnapshots: snapshots,
      tickerHeadlines: headlines.slice(0, config.tickerLimit),
      mediaSources,
      projectionUpdatedAt: Date.now(),
    });

    const translated = await translateProjection(snapshots, headlines, config);
    if (activeFingerprint !== fingerprint) return;
    publishLiveConfig({
      panelSnapshots: translated.snapshots,
      tickerHeadlines: translated.headlines.slice(0, config.tickerLimit),
      mediaSources,
      projectionUpdatedAt: Date.now(),
    });
  } finally {
    projectionRunning = false;
    if (rerunRequested) {
      rerunRequested = false;
      window.setTimeout(() => void publishProjection(room), 250);
    }
  }
}

function scheduleProjection(room: HTMLElement, delay = 900): void {
  if (debounceTimer !== null) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    void publishProjection(room);
  }, delay);
}

async function waitForControlRoom(timeoutMs = 30_000): Promise<HTMLElement | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const room = document.querySelector<HTMLElement>('#broadcastControlRoom');
    const grid = document.querySelector('#panelsGrid');
    if (room && grid) return room;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
  }
  return null;
}

export async function initBroadcastControlProjection(): Promise<void> {
  if (document.body.dataset.aynProjectionPublisher === '1') return;
  const room = await waitForControlRoom();
  if (!room) return;
  document.body.dataset.aynProjectionPublisher = '1';

  room.addEventListener('input', (event) => {
    if ((event.target as HTMLElement).classList.contains('ayn-control-search')) return;
    scheduleProjection(room, 250);
  });
  room.addEventListener('change', () => scheduleProjection(room, 250));

  observer?.disconnect();
  const grid = document.querySelector('#panelsGrid');
  if (grid) {
    observer = new MutationObserver(() => scheduleProjection(room, 1_200));
    observer.observe(grid, { childList: true, subtree: true, characterData: true });
  }

  if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
  heartbeatTimer = window.setInterval(() => void publishProjection(room), 8_000);
  void publishProjection(room, true);
  window.setTimeout(() => void publishProjection(room, true), 3_000);
  window.setTimeout(() => void publishProjection(room, true), 10_000);
}
