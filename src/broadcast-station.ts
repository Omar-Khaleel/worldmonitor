import './styles/broadcast-station.css';

type BroadcastColumns = 1 | 2 | 3 | 4;
type TranslationMode = 'server' | 'ollama' | 'off';

interface BroadcastConfig {
  version: 1;
  channelName: string;
  channelSubtitle: string;
  panelIds: string[];
  showMap: boolean;
  columns: BroadcastColumns;
  gapPx: number;
  tickerEnabled: boolean;
  tickerSpeedSeconds: number;
  tickerLimit: number;
  forceArabic: boolean;
  translatePanelHeadlines: boolean;
  translationMode: TranslationMode;
  ollamaUrl: string;
  ollamaModel: string;
}

const STORAGE_KEY = 'ayn-al-saqr-broadcast-config-v1';
const URL_CONFIG_KEY = 'bcfg';
const DEFAULT_CONFIG: BroadcastConfig = {
  version: 1,
  channelName: 'عين الصقر',
  channelSubtitle: 'قناة المعلومات والتحليل',
  panelIds: [],
  showMap: true,
  columns: 3,
  gapPx: 0,
  tickerEnabled: true,
  tickerSpeedSeconds: 38,
  tickerLimit: 18,
  forceArabic: true,
  translatePanelHeadlines: true,
  translationMode: 'server',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen2.5:7b',
};

const HEADLINE_SELECTOR = [
  '[data-headline]',
  '.news-item-title',
  '.news-title',
  '.headline',
  '.article-title',
  '.story-title',
  '.feed-item-title',
  'article h3',
  'article h4',
  '.panel-content a',
].join(',');

const translationCache = new Map<string, string>();
let refreshTimer: number | null = null;
let mutationObserver: MutationObserver | null = null;
let refreshPending = false;

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function normalizedPath(): string {
  return window.location.pathname.replace(/\/+$/, '') || '/';
}

function isViewerMode(params = new URL(window.location.href).searchParams): boolean {
  return normalizedPath() === '/broadcast' || params.get('broadcast') === '1';
}

function isControlMode(params = new URL(window.location.href).searchParams): boolean {
  const path = normalizedPath();
  return path === '/control' || path === '/station' || params.get('control') === '1';
}

export function prepareBroadcastLanguage(params = new URL(window.location.href).searchParams): void {
  if (!isViewerMode(params) && !isControlMode(params)) return;
  try {
    localStorage.setItem('wm-locale-explicit', 'ar');
  } catch {
    // Storage can be unavailable in hardened kiosk browsers.
  }
  document.documentElement.lang = 'ar';
  document.documentElement.dir = 'rtl';
}

function sanitizeConfig(input: Partial<BroadcastConfig> | null | undefined): BroadcastConfig {
  const panelIds = Array.isArray(input?.panelIds)
    ? input.panelIds.filter((value): value is string => typeof value === 'string').slice(0, 80)
    : [];
  const columns = [1, 2, 3, 4].includes(Number(input?.columns))
    ? Number(input?.columns) as BroadcastColumns
    : DEFAULT_CONFIG.columns;
  const mode: TranslationMode = input?.translationMode === 'ollama' || input?.translationMode === 'off'
    ? input.translationMode
    : 'server';

  return {
    version: 1,
    channelName: typeof input?.channelName === 'string' && input.channelName.trim()
      ? input.channelName.trim().slice(0, 80)
      : DEFAULT_CONFIG.channelName,
    channelSubtitle: typeof input?.channelSubtitle === 'string'
      ? input.channelSubtitle.trim().slice(0, 120)
      : DEFAULT_CONFIG.channelSubtitle,
    panelIds,
    showMap: input?.showMap !== false,
    columns,
    gapPx: Math.max(0, Math.min(24, Number(input?.gapPx ?? DEFAULT_CONFIG.gapPx))),
    tickerEnabled: input?.tickerEnabled !== false,
    tickerSpeedSeconds: Math.max(12, Math.min(120, Number(input?.tickerSpeedSeconds ?? DEFAULT_CONFIG.tickerSpeedSeconds))),
    tickerLimit: Math.max(5, Math.min(50, Number(input?.tickerLimit ?? DEFAULT_CONFIG.tickerLimit))),
    forceArabic: input?.forceArabic !== false,
    translatePanelHeadlines: input?.translatePanelHeadlines !== false,
    translationMode: mode,
    ollamaUrl: typeof input?.ollamaUrl === 'string' && input.ollamaUrl.trim()
      ? input.ollamaUrl.trim().replace(/\/$/, '')
      : DEFAULT_CONFIG.ollamaUrl,
    ollamaModel: typeof input?.ollamaModel === 'string' && input.ollamaModel.trim()
      ? input.ollamaModel.trim().slice(0, 120)
      : DEFAULT_CONFIG.ollamaModel,
  };
}

function encodeConfig(config: BroadcastConfig): string {
  const bytes = new TextEncoder().encode(JSON.stringify(config));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeConfig(encoded: string | null): BroadcastConfig | null {
  if (!encoded) return null;
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return sanitizeConfig(JSON.parse(new TextDecoder().decode(bytes)) as Partial<BroadcastConfig>);
  } catch (error) {
    console.warn('[broadcast] Invalid configuration in URL', error);
    return null;
  }
}

function loadConfig(): BroadcastConfig {
  const params = new URL(window.location.href).searchParams;
  const fromUrl = decodeConfig(params.get(URL_CONFIG_KEY));
  if (fromUrl) return fromUrl;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitizeConfig(JSON.parse(raw) as Partial<BroadcastConfig>);
  } catch (error) {
    console.warn('[broadcast] Could not read saved configuration', error);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: BroadcastConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (error) {
    console.warn('[broadcast] Could not save configuration', error);
  }
}

function buildViewerUrl(config: BroadcastConfig): string {
  const url = new URL(window.location.href);
  url.pathname = '/broadcast/';
  url.search = '';
  url.searchParams.set('broadcast', '1');
  url.searchParams.set('lang', 'ar');
  url.searchParams.set(URL_CONFIG_KEY, encodeConfig(config));
  return url.toString();
}

async function waitForDashboard(timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!document.querySelector('#panelsGrid') && Date.now() - started < timeoutMs) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
  }
}

function getPanelElements(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('#panelsGrid .panel[data-panel]'));
}

function getPanelTitle(panel: HTMLElement): string {
  return panel.querySelector<HTMLElement>('.panel-title')?.textContent?.trim()
    || panel.dataset.panel
    || 'لوحة';
}

function resolveSelectedPanelIds(config: BroadcastConfig): string[] {
  if (config.panelIds.length > 0) return config.panelIds;
  return getPanelElements()
    .filter((panel) => getComputedStyle(panel).display !== 'none')
    .slice(0, 8)
    .map((panel) => panel.dataset.panel)
    .filter((value): value is string => Boolean(value));
}

function applyPanelSelection(config: BroadcastConfig): BroadcastConfig {
  const selected = new Set(resolveSelectedPanelIds(config));
  for (const panel of getPanelElements()) {
    const id = panel.dataset.panel || '';
    panel.classList.toggle('broadcast-panel-hidden', !selected.has(id));
  }
  const map = document.querySelector<HTMLElement>('#mapSection');
  map?.classList.toggle('broadcast-panel-hidden', !config.showMap);
  return { ...config, panelIds: Array.from(selected) };
}

function mountChannelBug(config: BroadcastConfig): void {
  document.getElementById('broadcastChannelBug')?.remove();
  const wrapper = createElement('div', 'broadcast-channel-bug');
  wrapper.id = 'broadcastChannelBug';
  wrapper.setAttribute('aria-label', config.channelName);

  const mark = createElement('div', 'broadcast-channel-mark');
  mark.setAttribute('aria-hidden', 'true');
  const eye = createElement('span', 'broadcast-channel-eye', '◉');
  const wing = createElement('span', 'broadcast-channel-wing', '⌁');
  mark.append(eye, wing);

  const copy = createElement('div', 'broadcast-channel-copy');
  copy.append(
    createElement('strong', 'broadcast-channel-name', config.channelName),
    createElement('span', 'broadcast-channel-subtitle', config.channelSubtitle),
  );

  const live = createElement('span', 'broadcast-live-badge', 'مباشر');
  wrapper.append(mark, copy, live);
  document.body.appendChild(wrapper);
}

function normalizeHeadline(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[|•·]+$/g, '').trim();
}

function isLikelyHeadline(value: string): boolean {
  if (value.length < 24 || value.length > 260) return false;
  if (/^(read more|view all|show more|loading|retry|source|live|مباشر|المزيد|عرض الكل)$/i.test(value)) return false;
  if (/^https?:\/\//i.test(value)) return false;
  const words = value.split(/\s+/).length;
  return words >= 4;
}

function collectHeadlineNodes(limit = 80): HTMLElement[] {
  const selectedPanels = getPanelElements().filter((panel) => !panel.classList.contains('broadcast-panel-hidden'));
  const seen = new Set<string>();
  const nodes: HTMLElement[] = [];

  for (const panel of selectedPanels) {
    for (const node of panel.querySelectorAll<HTMLElement>(HEADLINE_SELECTOR)) {
      if (nodes.length >= limit) return nodes;
      if (node.children.length > 0 && !node.matches('[data-headline], .news-item-title, .news-title, .headline, .article-title, .story-title, .feed-item-title')) continue;
      const value = normalizeHeadline(node.dataset.broadcastOriginal || node.textContent || '');
      if (!isLikelyHeadline(value) || seen.has(value)) continue;
      seen.add(value);
      nodes.push(node);
    }
  }
  return nodes;
}

function containsArabic(value: string): boolean {
  const letters = value.match(/[A-Za-z\u0600-\u06FF]/g) || [];
  if (letters.length === 0) return false;
  const arabic = value.match(/[\u0600-\u06FF]/g) || [];
  return arabic.length / letters.length >= 0.65;
}

function parseTranslationPayload(content: string, expected: number): string[] {
  const cleaned = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item || '').trim()).slice(0, expected);
    }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { translations?: unknown[] }).translations)) {
      return (parsed as { translations: unknown[] }).translations
        .map((item) => String(item || '').trim())
        .slice(0, expected);
    }
  } catch {
    // Fall through to line-based recovery.
  }
  return cleaned
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, expected);
}

async function translateWithServer(items: string[]): Promise<string[]> {
  const response = await fetch('/api/broadcast/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!response.ok) throw new Error(`Translation server returned ${response.status}`);
  const data = await response.json() as { translations?: unknown[] };
  if (!Array.isArray(data.translations)) throw new Error('Translation server response is invalid');
  return data.translations.map((item) => String(item || '').trim());
}

async function translateWithOllama(items: string[], config: BroadcastConfig): Promise<string[]> {
  const response = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollamaModel,
      stream: false,
      format: 'json',
      messages: [
        {
          role: 'system',
          content: 'أنت مترجم أخبار محترف. ترجم العناوين إلى العربية الفصحى الإخبارية بدقة، من دون شرح أو إضافة معلومات. أعد JSON فقط بالشكل {"translations":["..."]} وبنفس الترتيب والعدد.',
        },
        { role: 'user', content: JSON.stringify({ items }) },
      ],
      options: { temperature: 0.1 },
    }),
  });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const data = await response.json() as { message?: { content?: string } };
  return parseTranslationPayload(data.message?.content || '', items.length);
}

async function translateBatch(items: string[], config: BroadcastConfig): Promise<string[]> {
  const output = [...items];
  const missingIndexes: number[] = [];
  const missing: string[] = [];

  items.forEach((item, index) => {
    if (containsArabic(item)) {
      translationCache.set(item, item);
      return;
    }
    const cached = translationCache.get(item);
    if (cached) {
      output[index] = cached;
      return;
    }
    missingIndexes.push(index);
    missing.push(item);
  });

  if (missing.length === 0 || config.translationMode === 'off') return output;

  try {
    const translated = config.translationMode === 'ollama'
      ? await translateWithOllama(missing, config)
      : await translateWithServer(missing);

    missingIndexes.forEach((outputIndex, translatedIndex) => {
      const value = normalizeHeadline(translated[translatedIndex] || missing[translatedIndex] || '');
      if (value) {
        output[outputIndex] = value;
        translationCache.set(missing[translatedIndex]!, value);
      }
    });
  } catch (error) {
    console.warn('[broadcast] Arabic translation failed; keeping source headlines', error);
  }
  return output;
}

async function localizeVisibleHeadlines(config: BroadcastConfig): Promise<string[]> {
  const nodes = collectHeadlineNodes(Math.max(config.tickerLimit * 3, 45));
  const originals = nodes.map((node) => normalizeHeadline(node.dataset.broadcastOriginal || node.textContent || ''));
  const translations: string[] = [];

  for (let index = 0; index < originals.length; index += 12) {
    const translated = await translateBatch(originals.slice(index, index + 12), config);
    translations.push(...translated);
  }

  if (config.translatePanelHeadlines) {
    nodes.forEach((node, index) => {
      const original = originals[index];
      const translated = translations[index];
      if (!original || !translated) return;
      if (!node.dataset.broadcastOriginal) node.dataset.broadcastOriginal = original;
      node.textContent = translated;
      node.lang = 'ar';
      node.dir = 'rtl';
      node.dataset.broadcastTranslated = 'true';
      if (translated !== original) node.title = original;
    });
  }

  return translations.filter(isLikelyHeadline).slice(0, config.tickerLimit);
}

function renderTickerItems(items: string[], config: BroadcastConfig): void {
  const track = document.querySelector<HTMLElement>('#broadcastTickerTrack');
  if (!track) return;
  track.replaceChildren();
  const headlines = items.length > 0
    ? items
    : ['عين الصقر تتابع آخر الأخبار والتحليلات لحظة بلحظة'];

  const sequence = [...headlines, ...headlines];
  sequence.forEach((headline, index) => {
    const item = createElement('span', 'broadcast-ticker-item');
    item.append(
      createElement('span', 'broadcast-ticker-dot', '◆'),
      createElement('span', 'broadcast-ticker-text', headline),
    );
    item.dataset.index = String(index);
    track.appendChild(item);
  });
  track.style.setProperty('--broadcast-ticker-duration', `${config.tickerSpeedSeconds}s`);
}

function mountTicker(config: BroadcastConfig): void {
  document.getElementById('broadcastTicker')?.remove();
  if (!config.tickerEnabled) return;

  const ticker = createElement('div', 'broadcast-ticker');
  ticker.id = 'broadcastTicker';
  ticker.dir = 'rtl';

  const label = createElement('div', 'broadcast-ticker-label');
  label.append(
    createElement('span', 'broadcast-ticker-pulse'),
    createElement('strong', '', 'آخر الأخبار'),
  );

  const viewport = createElement('div', 'broadcast-ticker-viewport');
  const track = createElement('div', 'broadcast-ticker-track');
  track.id = 'broadcastTickerTrack';
  viewport.appendChild(track);

  const clock = createElement('time', 'broadcast-ticker-clock');
  const updateClock = (): void => {
    clock.textContent = new Intl.DateTimeFormat('ar-IQ', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date());
  };
  updateClock();
  window.setInterval(updateClock, 1000);

  ticker.append(label, viewport, clock);
  document.body.appendChild(ticker);
}

async function refreshBroadcastNews(config: BroadcastConfig): Promise<void> {
  if (refreshPending) return;
  refreshPending = true;
  try {
    const items = await localizeVisibleHeadlines(config);
    renderTickerItems(items, config);
  } finally {
    refreshPending = false;
  }
}

function startBroadcastNews(config: BroadcastConfig): void {
  if (!config.tickerEnabled && !config.translatePanelHeadlines) return;
  void refreshBroadcastNews(config);
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => void refreshBroadcastNews(config), 60_000);

  mutationObserver?.disconnect();
  const root = document.querySelector('#panelsGrid');
  if (!root) return;
  let debounceTimer: number | null = null;
  mutationObserver = new MutationObserver(() => {
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => void refreshBroadcastNews(config), 2500);
  });
  mutationObserver.observe(root, { childList: true, subtree: true, characterData: true });
}

function applyViewerMode(rawConfig: BroadcastConfig): void {
  const config = applyPanelSelection(rawConfig);
  document.body.classList.add('broadcast-viewer');
  document.documentElement.style.setProperty('--broadcast-columns', String(config.columns));
  document.documentElement.style.setProperty('--broadcast-gap', `${config.gapPx}px`);
  document.documentElement.lang = 'ar';
  document.documentElement.dir = 'rtl';
  document.title = `${config.channelName} — بث مباشر`;
  mountChannelBug(config);
  mountTicker(config);
  startBroadcastNews(config);
}

function readFormConfig(container: HTMLElement, panels: HTMLElement[]): BroadcastConfig {
  const byId = <T extends HTMLInputElement | HTMLSelectElement>(id: string): T => {
    const element = container.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`Missing broadcast control: ${id}`);
    return element;
  };

  const panelIds = panels
    .map((panel) => panel.dataset.panel || '')
    .filter((id) => id && byId<HTMLInputElement>(`broadcast-panel-${CSS.escape(id)}`).checked);

  return sanitizeConfig({
    channelName: byId<HTMLInputElement>('broadcast-channel-name').value,
    channelSubtitle: byId<HTMLInputElement>('broadcast-channel-subtitle').value,
    panelIds,
    showMap: byId<HTMLInputElement>('broadcast-show-map').checked,
    columns: Number(byId<HTMLSelectElement>('broadcast-columns').value) as BroadcastColumns,
    gapPx: Number(byId<HTMLInputElement>('broadcast-gap').value),
    tickerEnabled: byId<HTMLInputElement>('broadcast-ticker-enabled').checked,
    tickerSpeedSeconds: Number(byId<HTMLInputElement>('broadcast-ticker-speed').value),
    tickerLimit: Number(byId<HTMLInputElement>('broadcast-ticker-limit').value),
    forceArabic: true,
    translatePanelHeadlines: byId<HTMLInputElement>('broadcast-translate-panels').checked,
    translationMode: byId<HTMLSelectElement>('broadcast-translation-mode').value as TranslationMode,
    ollamaUrl: byId<HTMLInputElement>('broadcast-ollama-url').value,
    ollamaModel: byId<HTMLInputElement>('broadcast-ollama-model').value,
  });
}

function createField(labelText: string, control: HTMLElement): HTMLElement {
  const label = createElement('label', 'broadcast-control-field');
  label.append(createElement('span', 'broadcast-control-label', labelText), control);
  return label;
}

function createCheckbox(id: string, checked: boolean, labelText: string): HTMLElement {
  const label = createElement('label', 'broadcast-control-check');
  const input = createElement('input') as HTMLInputElement;
  input.type = 'checkbox';
  input.id = id;
  input.checked = checked;
  label.append(input, createElement('span', '', labelText));
  return label;
}

function triggerConfigExport(config: BroadcastConfig): void {
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = createElement('a');
  link.href = url;
  link.download = 'ayn-al-saqr-broadcast.json';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function mountControlRoom(config: BroadcastConfig): void {
  document.body.classList.add('broadcast-control');
  document.documentElement.lang = 'ar';
  document.documentElement.dir = 'rtl';

  const panels = getPanelElements();
  const selected = new Set(resolveSelectedPanelIds(config));
  const control = createElement('aside', 'broadcast-control-room');
  control.id = 'broadcastControlRoom';

  const heading = createElement('header', 'broadcast-control-header');
  const headingCopy = createElement('div');
  headingCopy.append(
    createElement('strong', '', 'غرفة تحكم عين الصقر'),
    createElement('span', '', 'اختيار المشاهد والتخطيط ثم نشر رابط البث'),
  );
  const close = createElement('button', 'broadcast-control-close', '×');
  close.type = 'button';
  close.title = 'إخفاء غرفة التحكم';
  close.addEventListener('click', () => control.classList.toggle('broadcast-control-collapsed'));
  heading.append(headingCopy, close);

  const body = createElement('div', 'broadcast-control-body');
  const channelName = createElement('input') as HTMLInputElement;
  channelName.id = 'broadcast-channel-name';
  channelName.value = config.channelName;
  channelName.maxLength = 80;
  const channelSubtitle = createElement('input') as HTMLInputElement;
  channelSubtitle.id = 'broadcast-channel-subtitle';
  channelSubtitle.value = config.channelSubtitle;
  channelSubtitle.maxLength = 120;

  const columns = createElement('select') as HTMLSelectElement;
  columns.id = 'broadcast-columns';
  [1, 2, 3, 4].forEach((value) => {
    const option = createElement('option') as HTMLOptionElement;
    option.value = String(value);
    option.textContent = `${value} ${value === 1 ? 'عمود' : 'أعمدة'}`;
    option.selected = config.columns === value;
    columns.appendChild(option);
  });

  const gap = createElement('input') as HTMLInputElement;
  gap.id = 'broadcast-gap';
  gap.type = 'number';
  gap.min = '0';
  gap.max = '24';
  gap.value = String(config.gapPx);

  const tickerSpeed = createElement('input') as HTMLInputElement;
  tickerSpeed.id = 'broadcast-ticker-speed';
  tickerSpeed.type = 'range';
  tickerSpeed.min = '12';
  tickerSpeed.max = '120';
  tickerSpeed.value = String(config.tickerSpeedSeconds);

  const tickerLimit = createElement('input') as HTMLInputElement;
  tickerLimit.id = 'broadcast-ticker-limit';
  tickerLimit.type = 'number';
  tickerLimit.min = '5';
  tickerLimit.max = '50';
  tickerLimit.value = String(config.tickerLimit);

  const translationMode = createElement('select') as HTMLSelectElement;
  translationMode.id = 'broadcast-translation-mode';
  const modes: Array<[TranslationMode, string]> = [
    ['server', 'خادم ترجمة مركزي'],
    ['ollama', 'Ollama محلي'],
    ['off', 'بدون ترجمة آلية'],
  ];
  modes.forEach(([value, label]) => {
    const option = createElement('option') as HTMLOptionElement;
    option.value = value;
    option.textContent = label;
    option.selected = config.translationMode === value;
    translationMode.appendChild(option);
  });

  const ollamaUrl = createElement('input') as HTMLInputElement;
  ollamaUrl.id = 'broadcast-ollama-url';
  ollamaUrl.value = config.ollamaUrl;
  ollamaUrl.dir = 'ltr';
  const ollamaModel = createElement('input') as HTMLInputElement;
  ollamaModel.id = 'broadcast-ollama-model';
  ollamaModel.value = config.ollamaModel;
  ollamaModel.dir = 'ltr';

  body.append(
    createField('اسم القناة', channelName),
    createField('الوصف أسفل الشعار', channelSubtitle),
    createElement('h3', 'broadcast-control-section-title', 'تخطيط شاشة المشاهد'),
    createCheckbox('broadcast-show-map', config.showMap, 'إظهار الخريطة'),
    createField('عدد الأعمدة', columns),
    createField('المسافة بين الشاشات بالبكسل', gap),
    createElement('h3', 'broadcast-control-section-title', 'الشريط الإخباري والترجمة'),
    createCheckbox('broadcast-ticker-enabled', config.tickerEnabled, 'إظهار شريط الأخبار السفلي'),
    createCheckbox('broadcast-translate-panels', config.translatePanelHeadlines, 'ترجمة عناوين الأخبار داخل الشاشات'),
    createField('سرعة حركة الشريط', tickerSpeed),
    createField('عدد أخبار الشريط', tickerLimit),
    createField('مصدر الترجمة', translationMode),
    createField('عنوان Ollama', ollamaUrl),
    createField('نموذج Ollama', ollamaModel),
    createElement('h3', 'broadcast-control-section-title', 'الشاشات والقنوات الظاهرة'),
  );

  const panelTools = createElement('div', 'broadcast-panel-tools');
  const selectAll = createElement('button', '', 'اختيار الكل');
  selectAll.type = 'button';
  const clearAll = createElement('button', '', 'إلغاء الكل');
  clearAll.type = 'button';
  panelTools.append(selectAll, clearAll);
  body.appendChild(panelTools);

  const panelList = createElement('div', 'broadcast-panel-list');
  panels.forEach((panel) => {
    const id = panel.dataset.panel || '';
    if (!id) return;
    const row = createElement('label', 'broadcast-panel-option');
    const checkbox = createElement('input') as HTMLInputElement;
    checkbox.type = 'checkbox';
    checkbox.id = `broadcast-panel-${id}`;
    checkbox.checked = selected.has(id);
    row.append(
      checkbox,
      createElement('span', 'broadcast-panel-option-title', getPanelTitle(panel)),
      createElement('code', '', id),
    );
    panelList.appendChild(row);
  });
  body.appendChild(panelList);

  selectAll.addEventListener('click', () => {
    panelList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => { input.checked = true; });
  });
  clearAll.addEventListener('click', () => {
    panelList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => { input.checked = false; });
  });

  const status = createElement('div', 'broadcast-control-status');
  const actions = createElement('footer', 'broadcast-control-actions');
  const save = createElement('button', 'broadcast-primary-action', 'حفظ الإعدادات');
  const preview = createElement('button', '', 'فتح شاشة المشاهد');
  const copy = createElement('button', '', 'نسخ رابط البث');
  const exportButton = createElement('button', '', 'تصدير الإعدادات');
  const importButton = createElement('button', '', 'استيراد الإعدادات');
  [save, preview, copy, exportButton, importButton].forEach((button) => { button.type = 'button'; });
  actions.append(save, preview, copy, exportButton, importButton);

  const readCurrent = (): BroadcastConfig => readFormConfig(control, panels);
  save.addEventListener('click', () => {
    const next = readCurrent();
    saveConfig(next);
    status.textContent = 'تم حفظ إعدادات محطة البث.';
  });
  preview.addEventListener('click', () => {
    const next = readCurrent();
    saveConfig(next);
    window.open(buildViewerUrl(next), '_blank', 'noopener,noreferrer');
  });
  copy.addEventListener('click', async () => {
    const next = readCurrent();
    saveConfig(next);
    try {
      await navigator.clipboard.writeText(buildViewerUrl(next));
      status.textContent = 'تم نسخ رابط البث. افتحه في جهاز المشاهد أو OBS Browser Source.';
    } catch {
      status.textContent = buildViewerUrl(next);
    }
  });
  exportButton.addEventListener('click', () => triggerConfigExport(readCurrent()));

  const fileInput = createElement('input') as HTMLInputElement;
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  fileInput.hidden = true;
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const imported = sanitizeConfig(JSON.parse(await file.text()) as Partial<BroadcastConfig>);
      saveConfig(imported);
      status.textContent = 'تم استيراد الإعدادات. ستُعاد الصفحة لتطبيقها.';
      window.setTimeout(() => window.location.reload(), 500);
    } catch {
      status.textContent = 'ملف الإعدادات غير صالح.';
    }
  });
  importButton.addEventListener('click', () => fileInput.click());

  control.append(heading, body, status, actions, fileInput);
  document.body.appendChild(control);
}

export async function initBroadcastStation(): Promise<void> {
  const params = new URL(window.location.href).searchParams;
  if (!isViewerMode(params) && !isControlMode(params)) return;
  await waitForDashboard();
  const config = loadConfig();
  if (isViewerMode(params)) {
    applyViewerMode(config);
  } else {
    mountControlRoom(config);
  }
}
