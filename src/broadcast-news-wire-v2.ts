import { translateText } from '@/services';
import { loadLiveConfig, subscribeLiveConfig, type LiveBroadcastConfig } from '@/broadcast-sync';

interface HeadlineCandidate {
  text: string;
  score: number;
  order: number;
}

const SELECTOR = [
  '.item-title', '[data-headline]', '.news-item-title', '.news-title', '.headline',
  '.article-title', '.story-title', '.feed-item-title', '.panel-summary-text',
  'article h3', 'article h4',
].join(',');
const CACHE_KEY = 'ayn-al-saqr-arabic-wire-cache-v2';
const CACHE_TTL = 18 * 60 * 60 * 1000;
const cache = new Map<string, { value: string; at: number }>();
let observer: MutationObserver | null = null;
let interval: number | null = null;
let debounce: number | null = null;
let running = false;
let rerun = false;
let config = loadLiveConfig();

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[|•·]+$/g, '').trim();
}

function containsArabic(text: string): boolean {
  const letters = text.match(/[A-Za-z\u0600-\u06FF]/g) || [];
  if (letters.length === 0) return false;
  const arabic = text.match(/[\u0600-\u06FF]/g) || [];
  return arabic.length / letters.length >= 0.5;
}

function looksLikeHeadline(text: string): boolean {
  if (text.length < 16 || text.length > 320) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (/^(loading|retry|read more|view all|show more|live|source|مباشر|المزيد|عرض الكل)$/i.test(text)) return false;
  return text.split(/\s+/).filter(Boolean).length >= 3;
}

function panelScore(node: HTMLElement): number {
  const panel = node.closest<HTMLElement>('.panel[data-panel]');
  const id = panel?.dataset.panel || '';
  const title = panel?.querySelector<HTMLElement>('.panel-title')?.textContent || '';
  const text = `${id} ${title}`.toLowerCase();
  let score = 0;
  if (/politics|world|gov|government|us|europe|middleeast|africa|latam|asia/.test(text)) score += 180;
  if (/intel|insight|strategic|threat|risk|conflict|crisis|security|sanction/.test(text)) score += 145;
  if (/market|economic|energy|trade|technology|climate/.test(text)) score += 80;
  if (/live-news|live-webcams|camera|webcam|video|stream/.test(text)) score -= 220;
  if (panel?.classList.contains('broadcast-panel-hidden')) score -= 5; // Hidden panels still feed the wire.
  return score;
}

function collect(limit: number): string[] {
  const candidates: HeadlineCandidate[] = [];
  const seen = new Set<string>();
  let order = 0;
  document.querySelectorAll<HTMLElement>(SELECTOR).forEach((node) => {
    const original = normalize(node.dataset.aynOriginal || node.dataset.broadcastOriginal || node.dataset.original || node.textContent || '');
    if (!looksLikeHeadline(original)) return;
    const key = original.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ text: original, score: panelScore(node), order: order++ });
  });
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates.slice(0, Math.max(limit * 3, 60)).map((item) => item.text);
}

function loadCache(): void {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') as Record<string, { value: string; at: number }>;
    const now = Date.now();
    for (const [key, entry] of Object.entries(parsed)) {
      if (entry?.value && containsArabic(entry.value) && now - Number(entry.at || 0) < CACHE_TTL) cache.set(key, entry);
    }
  } catch {
    // Ignore damaged cache.
  }
}

function saveCache(): void {
  try {
    const entries = Array.from(cache.entries()).sort((a, b) => b[1].at - a[1].at).slice(0, 500);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Cache is optional.
  }
}

function parseProvider(content: string, expected: number): string[] {
  const cleaned = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    const values = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? (parsed as { translations?: unknown }).translations : null;
    if (Array.isArray(values)) return values.map((value) => normalize(String(value || ''))).slice(0, expected);
  } catch {
    // Recover numbered/plain responses below.
  }
  return cleaned.split(/\n+/).map((line) => normalize(line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, ''))).filter(Boolean).slice(0, expected);
}

async function translateApplication(items: string[]): Promise<string[]> {
  const output: string[] = [];
  for (let start = 0; start < items.length; start += 5) {
    const batch = items.slice(start, start + 5);
    output.push(...await Promise.all(batch.map(async (item) => {
      try { return normalize((await translateText(item, 'ar')) || ''); } catch { return ''; }
    })));
  }
  return output;
}

async function translateOllama(items: string[], current: LiveBroadcastConfig): Promise<string[]> {
  const response = await fetch(`${current.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: current.ollamaModel,
      stream: false,
      format: 'json',
      options: { temperature: 0.05 },
      messages: [
        { role: 'system', content: 'أنت محرر شريط أخبار عربي محترف. ترجم العناوين إلى العربية الفصحى الإخبارية بدقة، مع الحفاظ على الأسماء والأرقام والتواريخ، ومن دون رأي أو شرح. أعد JSON فقط بالشكل {"translations":["..."]} وبنفس العدد والترتيب.' },
        { role: 'user', content: JSON.stringify({ items }) },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}`);
  const payload = await response.json() as { message?: { content?: string } };
  return parseProvider(payload.message?.content || '', items.length);
}

async function translateServer(items: string[]): Promise<string[]> {
  const response = await fetch('/api/broadcast/translate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }),
  });
  if (!response.ok) throw new Error(`Server ${response.status}`);
  const payload = await response.json() as { translations?: unknown[] };
  if (!Array.isArray(payload.translations)) throw new Error('Invalid translation response');
  return payload.translations.map((value) => normalize(String(value || '')));
}

async function translateBatch(items: string[], current: LiveBroadcastConfig): Promise<string[]> {
  const providers = current.translationMode === 'ollama'
    ? [() => translateOllama(items, current), () => translateApplication(items), () => translateServer(items)]
    : [() => translateApplication(items), () => translateServer(items), () => translateOllama(items, current)];
  for (const provider of providers) {
    try {
      const result = await provider();
      if (result.some(containsArabic)) return result;
    } catch {
      // Try next provider.
    }
  }
  return [];
}

async function arabicHeadlines(source: string[], current: LiveBroadcastConfig): Promise<string[]> {
  const output = [...source];
  const missing: string[] = [];
  const indexes: number[] = [];
  source.forEach((item, index) => {
    if (containsArabic(item)) return;
    const cached = cache.get(item);
    if (cached?.value && containsArabic(cached.value)) {
      output[index] = cached.value;
      return;
    }
    missing.push(item);
    indexes.push(index);
  });

  if (current.translationMode !== 'off') {
    for (let start = 0; start < missing.length; start += 8) {
      const batch = missing.slice(start, start + 8);
      const translated = await translateBatch(batch, current);
      batch.forEach((original, offset) => {
        const value = normalize(translated[offset] || '');
        const target = indexes[start + offset];
        if (target === undefined || !containsArabic(value)) return;
        output[target] = value;
        cache.set(original, { value, at: Date.now() });
      });
    }
  }
  saveCache();
  const seen = new Set<string>();
  return output.filter(containsArabic).filter(looksLikeHeadline).filter((value) => {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, current.tickerLimit);
}

function render(items: string[], state: 'loading' | 'live' | 'error'): void {
  const track = document.querySelector<HTMLElement>('#broadcastTickerTrack');
  if (!track) return;
  const content = items.length > 0 ? items : [
    state === 'loading' ? 'جارٍ جمع الأخبار العالمية وترجمتها إلى العربية...' : 'تعذر الاتصال بخدمة الترجمة؛ تحقق من إعدادات Ollama أو خادم الترجمة في غرفة التحكم.',
  ];
  track.replaceChildren();
  for (const headline of [...content, ...content]) {
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
  const duration = Math.max(config.tickerSpeedSeconds, Math.round(content.length * 4.5));
  track.style.setProperty('--broadcast-ticker-duration', `${Math.min(duration, 180)}s`);
  track.dataset.aynGlobalNewsWire = 'true';
  document.body.dataset.aynTickerStatus = state;
  document.body.dataset.aynTickerCount = String(items.length);
}

async function refresh(): Promise<void> {
  if (running) { rerun = true; return; }
  running = true;
  try {
    config = loadLiveConfig();
    if (!config.tickerEnabled) return;
    const source = collect(config.tickerLimit);
    const immediateArabic = source.filter(containsArabic).slice(0, config.tickerLimit);
    render(immediateArabic, 'loading');
    if (source.length === 0) {
      render([], 'loading');
      return;
    }
    const translated = await arabicHeadlines(source, config);
    render(translated, translated.length > 0 ? 'live' : 'error');
  } finally {
    running = false;
    if (rerun) {
      rerun = false;
      window.setTimeout(() => void refresh(), 500);
    }
  }
}

function schedule(delay = 900): void {
  if (debounce !== null) window.clearTimeout(debounce);
  debounce = window.setTimeout(() => { debounce = null; void refresh(); }, delay);
}

export function initBroadcastNewsWireV2(): void {
  const params = new URL(window.location.href).searchParams;
  if (params.get('broadcast') !== '1') return;
  if (document.body.dataset.aynNewsWireV2 === '1') return;
  document.body.dataset.aynNewsWireV2 = '1';
  loadCache();
  render([], 'loading');
  schedule(250);
  window.setTimeout(() => schedule(50), 3000);
  window.setTimeout(() => schedule(50), 8000);
  window.setTimeout(() => schedule(50), 16000);

  observer = new MutationObserver(() => schedule(1800));
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  if (interval !== null) window.clearInterval(interval);
  interval = window.setInterval(() => schedule(50), 30_000);
  subscribeLiveConfig((next) => {
    config = next;
    schedule(50);
  });
}
