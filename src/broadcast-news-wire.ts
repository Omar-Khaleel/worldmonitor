import { translateText } from '@/services';

type TranslationMode = 'server' | 'ollama' | 'off';

interface BroadcastTranslationConfig {
  translationMode: TranslationMode;
  ollamaUrl: string;
  ollamaModel: string;
  tickerSpeedSeconds: number;
  tickerLimit: number;
}

interface CacheEntry {
  value: string;
  savedAt: number;
}

interface RankedHeadline {
  text: string;
  score: number;
  order: number;
}

const STORAGE_KEY = 'ayn-al-saqr-broadcast-config-v1';
const URL_CONFIG_KEY = 'bcfg';
const CACHE_KEY = 'ayn-al-saqr-ticker-ar-cache-v1';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_CACHE_ITEMS = 350;
const DEFAULT_CONFIG: BroadcastTranslationConfig = {
  translationMode: 'server',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen2.5:7b',
  tickerSpeedSeconds: 44,
  tickerLimit: 24,
};

const HEADLINE_SELECTOR = [
  '.item-title',
  '[data-headline]',
  '.news-item-title',
  '.news-title',
  '.headline',
  '.article-title',
  '.story-title',
  '.feed-item-title',
  'article h3',
  'article h4',
].join(',');

const PRIORITY_PANEL_IDS = new Set([
  'politics', 'us', 'europe', 'middleeast', 'africa', 'latam', 'asia',
  'gov', 'thinktanks', 'intel', 'gdelt-intel', 'insights', 'strategic-posture',
  'threat-timeline', 'strategic-risk', 'security-advisories', 'sanctions-pressure',
  'climate-news', 'energy', 'markets', 'economic', 'tech', 'airline-intel',
]);

const STRONG_KEYWORDS = [
  'world', 'global', 'politic', 'government', 'geopolit', 'conflict', 'crisis',
  'security', 'military', 'war', 'intelligence', 'news', 'breaking', 'diplom',
  'عالم', 'سياس', 'حكوم', 'أخبار', 'استخبار', 'صراع', 'أزمة', 'أمن', 'عسكر', 'حرب',
];

const SECONDARY_KEYWORDS = [
  'econom', 'market', 'energy', 'climate', 'technology', 'sanction', 'trade',
  'اقتصاد', 'سوق', 'طاقة', 'مناخ', 'تقنية', 'عقوبات', 'تجارة',
];

const cache = new Map<string, CacheEntry>();
let panelObserver: MutationObserver | null = null;
let tickerObserver: MutationObserver | null = null;
let refreshTimer: number | null = null;
let debounceTimer: number | null = null;
let running = false;
let rerunRequested = false;
let writingTicker = false;

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[|•·]+$/g, '').trim();
}

function containsArabic(value: string): boolean {
  const letters = value.match(/[A-Za-z\u0600-\u06FF]/g) || [];
  if (letters.length === 0) return false;
  const arabic = value.match(/[\u0600-\u06FF]/g) || [];
  return arabic.length / letters.length >= 0.58;
}

function isHeadline(value: string): boolean {
  if (value.length < 18 || value.length > 280) return false;
  if (/^https?:\/\//i.test(value)) return false;
  if (/^(loading|retry|read more|view all|show more|live|source|مباشر|المزيد|عرض الكل)$/i.test(value)) return false;
  return value.split(/\s+/).filter(Boolean).length >= 4;
}

function decodeUrlConfig(encoded: string | null): Partial<BroadcastTranslationConfig> | null {
  if (!encoded) return null;
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Partial<BroadcastTranslationConfig>;
  } catch {
    return null;
  }
}

function loadConfig(): BroadcastTranslationConfig {
  let raw: Partial<BroadcastTranslationConfig> | null = null;
  try {
    const url = new URL(window.location.href);
    raw = decodeUrlConfig(url.searchParams.get(URL_CONFIG_KEY));
    if (!raw) {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) raw = JSON.parse(stored) as Partial<BroadcastTranslationConfig>;
    }
  } catch {
    raw = null;
  }

  const mode: TranslationMode = raw?.translationMode === 'ollama'
    ? 'ollama'
    : raw?.translationMode === 'off'
      ? 'off'
      : 'server';

  return {
    translationMode: mode,
    ollamaUrl: typeof raw?.ollamaUrl === 'string' && raw.ollamaUrl.trim()
      ? raw.ollamaUrl.trim().replace(/\/$/, '')
      : DEFAULT_CONFIG.ollamaUrl,
    ollamaModel: typeof raw?.ollamaModel === 'string' && raw.ollamaModel.trim()
      ? raw.ollamaModel.trim()
      : DEFAULT_CONFIG.ollamaModel,
    tickerSpeedSeconds: Math.max(18, Math.min(120, Number(raw?.tickerSpeedSeconds ?? DEFAULT_CONFIG.tickerSpeedSeconds))),
    tickerLimit: Math.max(10, Math.min(40, Number(raw?.tickerLimit ?? DEFAULT_CONFIG.tickerLimit))),
  };
}

function loadCache(): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
    const now = Date.now();
    Object.entries(parsed).forEach(([key, entry]) => {
      if (entry && typeof entry.value === 'string' && now - Number(entry.savedAt || 0) < CACHE_TTL_MS) {
        cache.set(key, entry);
      }
    });
  } catch {
    // Ignore damaged or unavailable storage.
  }
}

function saveCache(): void {
  try {
    const entries = Array.from(cache.entries())
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .slice(0, MAX_CACHE_ITEMS);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage is optional for kiosk mode.
  }
}

function panelPriority(panel: HTMLElement): number {
  const id = (panel.dataset.panel || '').toLowerCase();
  const title = normalize(panel.querySelector<HTMLElement>('.panel-title')?.textContent || '').toLowerCase();
  const haystack = `${id} ${title}`;
  let score = 0;
  if (PRIORITY_PANEL_IDS.has(id)) score += 120;
  for (const keyword of STRONG_KEYWORDS) if (haystack.includes(keyword)) score += 28;
  for (const keyword of SECONDARY_KEYWORDS) if (haystack.includes(keyword)) score += 10;
  if (/live-news|live-webcams|windy-webcams|camera|webcam|video|stream/.test(id)) score -= 150;
  return score;
}

function collectGlobalHeadlines(limit: number): string[] {
  const panels = Array.from(document.querySelectorAll<HTMLElement>('#panelsGrid .panel[data-panel]'))
    .map((panel, index) => ({ panel, score: panelPriority(panel), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const ranked: RankedHeadline[] = [];
  const seen = new Set<string>();
  let order = 0;

  for (const { panel, score } of panels) {
    for (const node of panel.querySelectorAll<HTMLElement>(HEADLINE_SELECTOR)) {
      const value = normalize(
        node.dataset.aynOriginal
        || node.dataset.broadcastOriginal
        || node.dataset.original
        || node.textContent
        || '',
      );
      if (!isHeadline(value)) continue;
      const key = value.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ranked.push({ text: value, score, order: order++ });
    }
  }

  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  return ranked.slice(0, Math.max(limit * 2, 36)).map((item) => item.text);
}

function parseTranslations(content: string, expected: number): string[] {
  const cleaned = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    const values = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? (parsed as { translations?: unknown }).translations
        : null;
    if (Array.isArray(values)) {
      return values.map((value) => normalize(String(value || ''))).slice(0, expected);
    }
  } catch {
    // Some providers return numbered lines instead of JSON.
  }
  return cleaned
    .split(/\n+/)
    .map((line) => normalize(line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '')))
    .filter(Boolean)
    .slice(0, expected);
}

async function translateWithServer(items: string[]): Promise<string[]> {
  const response = await fetch('/api/broadcast/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!response.ok) throw new Error(`translation server returned ${response.status}`);
  const payload = await response.json() as { translations?: unknown[] };
  if (!Array.isArray(payload.translations)) throw new Error('invalid translation server response');
  return payload.translations.map((value) => normalize(String(value || '')));
}

async function translateWithOllama(items: string[], config: BroadcastTranslationConfig): Promise<string[]> {
  const response = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollamaModel,
      stream: false,
      format: 'json',
      options: { temperature: 0.05 },
      messages: [
        {
          role: 'system',
          content: 'أنت محرر شريط أخبار عربي محترف. ترجم العناوين إلى العربية الفصحى الإخبارية بدقة، وحافظ على الأسماء والأرقام والتواريخ. لا تضف تفسيراً أو رأياً. أعد JSON فقط بالشكل {"translations":["..."]} وبنفس العدد والترتيب.',
        },
        { role: 'user', content: JSON.stringify({ items }) },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const payload = await response.json() as { message?: { content?: string } };
  return parseTranslations(payload.message?.content || '', items.length);
}

async function translateWithApplication(items: string[]): Promise<string[]> {
  const output: string[] = [];
  for (let start = 0; start < items.length; start += 4) {
    const batch = items.slice(start, start + 4);
    const translated = await Promise.all(batch.map(async (item) => {
      try {
        return normalize((await translateText(item, 'ar')) || '');
      } catch {
        return '';
      }
    }));
    output.push(...translated);
  }
  return output;
}

async function translateMissing(items: string[], config: BroadcastTranslationConfig): Promise<string[]> {
  const providers = config.translationMode === 'ollama'
    ? [
        () => translateWithOllama(items, config),
        () => translateWithServer(items),
        () => translateWithApplication(items),
      ]
    : [
        () => translateWithServer(items),
        () => translateWithOllama(items, config),
        () => translateWithApplication(items),
      ];

  let best: string[] = [];
  for (const provider of providers) {
    try {
      const result = await provider();
      if (result.some((value) => containsArabic(value))) return result;
      if (result.length > best.length) best = result;
    } catch {
      // Try the next translation provider.
    }
  }
  return best;
}

async function ensureArabic(items: string[], config: BroadcastTranslationConfig): Promise<string[]> {
  const output = [...items];
  const missing: string[] = [];
  const indexes: number[] = [];

  items.forEach((item, index) => {
    if (containsArabic(item)) return;
    const cached = cache.get(item);
    if (cached && containsArabic(cached.value)) {
      output[index] = cached.value;
      return;
    }
    missing.push(item);
    indexes.push(index);
  });

  for (let start = 0; start < missing.length; start += 8) {
    const batch = missing.slice(start, start + 8);
    const translated = await translateMissing(batch, config);
    batch.forEach((original, offset) => {
      const value = normalize(translated[offset] || '');
      const targetIndex = indexes[start + offset];
      if (targetIndex === undefined || !containsArabic(value)) return;
      output[targetIndex] = value;
      cache.set(original, { value, savedAt: Date.now() });
    });
  }

  saveCache();
  const unique = new Set<string>();
  return output
    .map(normalize)
    .filter((value) => containsArabic(value) && isHeadline(value))
    .filter((value) => {
      const key = value.toLocaleLowerCase();
      if (unique.has(key)) return false;
      unique.add(key);
      return true;
    })
    .slice(0, config.tickerLimit);
}

function renderTicker(items: string[], config: BroadcastTranslationConfig): void {
  const track = document.querySelector<HTMLElement>('#broadcastTickerTrack');
  if (!track) return;

  const headlines = items.length > 0
    ? items
    : ['عين الصقر تتابع التطورات العالمية والسياسية لحظة بلحظة'];

  writingTicker = true;
  track.replaceChildren();
  for (const headline of [...headlines, ...headlines]) {
    const item = document.createElement('span');
    item.className = 'broadcast-ticker-item';
    item.dir = 'rtl';

    const dot = document.createElement('span');
    dot.className = 'broadcast-ticker-dot';
    dot.textContent = '◆';

    const text = document.createElement('span');
    text.className = 'broadcast-ticker-text';
    text.lang = 'ar';
    text.dir = 'rtl';
    text.textContent = headline;

    item.append(dot, text);
    track.appendChild(item);
  }

  const adaptiveDuration = Math.max(config.tickerSpeedSeconds, Math.round(headlines.length * 4.5));
  track.style.setProperty('--broadcast-ticker-duration', `${Math.min(adaptiveDuration, 120)}s`);
  track.dataset.aynGlobalNewsWire = 'true';
  window.queueMicrotask(() => { writingTicker = false; });
}

async function refreshTicker(): Promise<void> {
  if (running) {
    rerunRequested = true;
    return;
  }
  running = true;
  document.body.dataset.aynTickerStatus = 'refreshing';

  try {
    const config = loadConfig();
    const source = collectGlobalHeadlines(config.tickerLimit);
    const arabic = await ensureArabic(source, config);
    renderTicker(arabic, config);
    document.body.dataset.aynTickerStatus = arabic.length > 0 ? 'live' : 'waiting';
  } catch (error) {
    document.body.dataset.aynTickerStatus = 'error';
    console.warn('[عين الصقر] تعذر تحديث الشريط الإخباري العالمي', error);
  } finally {
    running = false;
    if (rerunRequested) {
      rerunRequested = false;
      window.setTimeout(() => void refreshTicker(), 600);
    }
  }
}

function scheduleRefresh(delay = 1200): void {
  if (debounceTimer !== null) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    void refreshTicker();
  }, delay);
}

export function initBroadcastNewsWire(): void {
  const params = new URL(window.location.href).searchParams;
  if (params.get('broadcast') !== '1') return;
  if (document.body.dataset.aynGlobalNewsWire === '1') return;
  document.body.dataset.aynGlobalNewsWire = '1';

  loadCache();
  scheduleRefresh(400);

  const panelRoot = document.querySelector('#panelsGrid');
  if (panelRoot) {
    panelObserver = new MutationObserver(() => scheduleRefresh(2400));
    panelObserver.observe(panelRoot, { childList: true, subtree: true, characterData: true });
  }

  const tickerTrack = document.querySelector('#broadcastTickerTrack');
  if (tickerTrack) {
    tickerObserver = new MutationObserver(() => {
      if (!writingTicker) scheduleRefresh(350);
    });
    tickerObserver.observe(tickerTrack, { childList: true, subtree: true, characterData: true });
  }

  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => scheduleRefresh(100), 30_000);
}
