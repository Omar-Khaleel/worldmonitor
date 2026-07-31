type TranslationMode = 'server' | 'ollama' | 'off';

interface TranslationConfig {
  translationMode: TranslationMode;
  ollamaUrl: string;
  ollamaModel: string;
  translatePanelHeadlines: boolean;
}

const STORAGE_KEY = 'ayn-al-saqr-broadcast-config-v1';
const URL_CONFIG_KEY = 'bcfg';
const DEFAULT_CONFIG: TranslationConfig = {
  translationMode: 'ollama',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen2.5:7b',
  translatePanelHeadlines: true,
};

const TRANSLATABLE_SELECTOR = [
  '.item-title',
  '.item-snippet',
  '[data-headline]',
  '.news-item-title',
  '.news-title',
  '.headline',
  '.article-title',
  '.story-title',
  '.feed-item-title',
  '.news-summary',
  '.article-summary',
  '.item-description',
  '.event-description',
  '.panel-summary-text',
  'article h3',
  'article h4',
].join(',');

const cache = new Map<string, string>();
let observer: MutationObserver | null = null;
let intervalId: number | null = null;
let debounceId: number | null = null;
let running = false;
let rerunRequested = false;

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function containsArabic(value: string): boolean {
  const relevant = value.match(/[A-Za-z\u0600-\u06FF]/g) || [];
  if (relevant.length === 0) return false;
  const arabic = value.match(/[\u0600-\u06FF]/g) || [];
  return arabic.length / relevant.length >= 0.58;
}

function isEligible(value: string): boolean {
  if (value.length < 12 || value.length > 420) return false;
  if (/^https?:\/\//i.test(value)) return false;
  if (/^(loading|retry|read more|view all|show more|live|source|مباشر|المزيد|عرض الكل)$/i.test(value)) return false;
  const words = value.split(/\s+/).filter(Boolean);
  return words.length >= 3;
}

function decodeUrlConfig(encoded: string | null): Partial<TranslationConfig> | null {
  if (!encoded) return null;
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Partial<TranslationConfig>;
  } catch {
    return null;
  }
}

function loadConfig(): TranslationConfig {
  let raw: Partial<TranslationConfig> | null = null;
  try {
    const url = new URL(window.location.href);
    raw = decodeUrlConfig(url.searchParams.get(URL_CONFIG_KEY));
    if (!raw) {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) raw = JSON.parse(stored) as Partial<TranslationConfig>;
    }
  } catch {
    raw = null;
  }

  const mode: TranslationMode = raw?.translationMode === 'off'
    ? 'off'
    : raw?.translationMode === 'server'
      ? 'server'
      : 'ollama';

  return {
    translationMode: mode,
    ollamaUrl: typeof raw?.ollamaUrl === 'string' && raw.ollamaUrl.trim()
      ? raw.ollamaUrl.trim().replace(/\/$/, '')
      : DEFAULT_CONFIG.ollamaUrl,
    ollamaModel: typeof raw?.ollamaModel === 'string' && raw.ollamaModel.trim()
      ? raw.ollamaModel.trim()
      : DEFAULT_CONFIG.ollamaModel,
    translatePanelHeadlines: raw?.translatePanelHeadlines !== false,
  };
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
    // Recover providers that return plain numbered lines.
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

async function translateWithOllama(items: string[], config: TranslationConfig): Promise<string[]> {
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
          content: 'أنت محرر أخبار عربي محترف. ترجم النصوص الآتية إلى العربية الفصحى الإخبارية بدقة. حافظ على الأسماء والأرقام والتواريخ، ولا تضف رأياً أو شرحاً. أعد JSON فقط بالشكل {"translations":["..."]} وبنفس العدد والترتيب.',
        },
        { role: 'user', content: JSON.stringify({ items }) },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const payload = await response.json() as { message?: { content?: string } };
  return parseTranslations(payload.message?.content || '', items.length);
}

async function translateBatch(items: string[], config: TranslationConfig): Promise<string[]> {
  if (config.translationMode === 'off') return items;

  const providers = config.translationMode === 'server'
    ? [
        () => translateWithServer(items),
        () => translateWithOllama(items, config),
      ]
    : [
        () => translateWithOllama(items, config),
        () => translateWithServer(items),
      ];

  let lastError: unknown = null;
  for (const provider of providers) {
    try {
      const result = await provider();
      if (result.length > 0) return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('all translation providers failed');
}

function selectedVisiblePanels(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('#panelsGrid .panel[data-panel]'))
    .filter((panel) => !panel.classList.contains('broadcast-panel-hidden'))
    .filter((panel) => getComputedStyle(panel).display !== 'none');
}

function collectNodes(limit = 160): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const panel of selectedVisiblePanels()) {
    for (const node of panel.querySelectorAll<HTMLElement>(TRANSLATABLE_SELECTOR)) {
      if (nodes.length >= limit) return nodes;
      if (seen.has(node)) continue;
      if (node.closest('button, select, option, .item-source, .item-time')) continue;
      if (node.children.length > 0 && !node.matches('.item-title, .item-snippet, [data-headline], .news-item-title, .news-title, .headline, .article-title, .story-title, .feed-item-title, .news-summary, .article-summary, .item-description, .event-description, .panel-summary-text')) continue;
      const current = normalize(node.textContent || '');
      if (!isEligible(current)) continue;
      seen.add(node);
      nodes.push(node);
    }
  }
  return nodes;
}

function markArabic(node: HTMLElement, original?: string): void {
  if (original && !node.dataset.aynOriginal) node.dataset.aynOriginal = original;
  node.dataset.aynTranslated = 'true';
  node.lang = 'ar';
  node.dir = 'rtl';
}

function triggerNativeNewsTranslation(): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(
    '#panelsGrid .panel:not(.broadcast-panel-hidden) .item-translate-btn:not([data-ayn-auto-translate])',
  )).slice(0, 40);

  buttons.forEach((button, index) => {
    button.dataset.aynAutoTranslate = 'true';
    window.setTimeout(() => {
      if (button.isConnected && !button.disabled) button.click();
    }, index * 75);
  });
}

async function translateVisibleNews(): Promise<void> {
  if (running) {
    rerunRequested = true;
    return;
  }
  running = true;
  document.body.dataset.broadcastTranslationStatus = 'running';

  try {
    const config = loadConfig();
    if (!config.translatePanelHeadlines || config.translationMode === 'off') {
      document.body.dataset.broadcastTranslationStatus = 'off';
      return;
    }

    // Use the application's own item translator first where available.
    triggerNativeNewsTranslation();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 1400));

    const nodes = collectNodes();
    const pendingNodes: HTMLElement[] = [];
    const pendingOriginals: string[] = [];

    for (const node of nodes) {
      const current = normalize(node.textContent || '');
      if (!current) continue;

      if (containsArabic(current)) {
        markArabic(node, node.dataset.aynOriginal || undefined);
        continue;
      }

      const original = normalize(node.dataset.aynOriginal || current);
      if (!isEligible(original)) continue;
      const cached = cache.get(original);
      if (cached) {
        if (!node.dataset.aynOriginal) node.dataset.aynOriginal = original;
        node.textContent = cached;
        markArabic(node, original);
        node.title = original;
        continue;
      }

      pendingNodes.push(node);
      pendingOriginals.push(original.slice(0, 400));
    }

    for (let start = 0; start < pendingOriginals.length; start += 8) {
      const originals = pendingOriginals.slice(start, start + 8);
      const translated = await translateBatch(originals, config);
      originals.forEach((original, offset) => {
        const node = pendingNodes[start + offset];
        const value = normalize(translated[offset] || '');
        if (!node?.isConnected || !value) return;
        cache.set(original, value);
        if (!node.dataset.aynOriginal) node.dataset.aynOriginal = original;
        node.textContent = value;
        node.title = original;
        markArabic(node, original);
      });
    }

    document.body.dataset.broadcastTranslationStatus = 'ready';
  } catch (error) {
    document.body.dataset.broadcastTranslationStatus = 'error';
    console.warn('[عين الصقر] تعذرت ترجمة بعض أخبار البث', error);
  } finally {
    running = false;
    if (rerunRequested) {
      rerunRequested = false;
      window.setTimeout(() => void translateVisibleNews(), 500);
    }
  }
}

function scheduleTranslation(delay = 1200): void {
  if (debounceId !== null) window.clearTimeout(debounceId);
  debounceId = window.setTimeout(() => {
    debounceId = null;
    void translateVisibleNews();
  }, delay);
}

export function initBroadcastTranslationHotfix(): void {
  const params = new URL(window.location.href).searchParams;
  if (params.get('broadcast') !== '1') return;
  if (document.body.dataset.aynTranslationHotfix === '1') return;
  document.body.dataset.aynTranslationHotfix = '1';

  scheduleTranslation(300);
  const root = document.querySelector('#panelsGrid');
  if (root) {
    observer = new MutationObserver(() => scheduleTranslation(1500));
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  }

  if (intervalId !== null) window.clearInterval(intervalId);
  intervalId = window.setInterval(() => scheduleTranslation(200), 45_000);
}
