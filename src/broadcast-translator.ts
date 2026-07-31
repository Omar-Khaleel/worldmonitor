import type { LiveBroadcastConfig } from '@/broadcast-sync';

const translationCache = new Map<string, string>();
const MAX_BATCH = 8;
const REQUEST_TIMEOUT_MS = 12_000;

export function containsArabic(value: string): boolean {
  const letters = value.match(/[A-Za-z\u0600-\u06FF]/g) || [];
  if (letters.length === 0) return false;
  const arabic = value.match(/[\u0600-\u06FF]/g) || [];
  return arabic.length / letters.length >= 0.5;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 320);
}

function parseProvider(content: string, expected: number): string[] {
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
    // Recover numbered or plain-line output below.
  }
  return cleaned
    .split(/\n+/)
    .map((line) => normalize(line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '')))
    .filter(Boolean)
    .slice(0, expected);
}

async function withTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

async function translateWithServer(items: string[]): Promise<string[]> {
  const response = await withTimeout('/api/broadcast/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!response.ok) throw new Error(`translation server ${response.status}`);
  const payload = await response.json() as { translations?: unknown[] };
  if (!Array.isArray(payload.translations)) throw new Error('invalid translation response');
  return payload.translations.map((value) => normalize(String(value || '')));
}

async function translateWithOllama(items: string[], config: LiveBroadcastConfig): Promise<string[]> {
  const response = await withTimeout(`${config.ollamaUrl}/api/chat`, {
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
          content: 'أنت محرر أخبار عربي محترف. ترجم النصوص إلى العربية الفصحى الإخبارية بدقة، مع الحفاظ على الأسماء والأرقام والتواريخ، ومن دون شرح أو رأي. أعد JSON فقط بالشكل {"translations":["..."]} وبنفس العدد والترتيب.',
        },
        { role: 'user', content: JSON.stringify({ items }) },
      ],
    }),
  });
  if (!response.ok) throw new Error(`ollama ${response.status}`);
  const payload = await response.json() as { message?: { content?: string } };
  return parseProvider(payload.message?.content || '', items.length);
}

async function translateMissing(items: string[], config: LiveBroadcastConfig): Promise<string[]> {
  if (config.translationMode === 'off') return items;
  const providers = config.translationMode === 'ollama'
    ? [() => translateWithOllama(items, config), () => translateWithServer(items)]
    : [() => translateWithServer(items), () => translateWithOllama(items, config)];

  for (const provider of providers) {
    try {
      const translated = await provider();
      if (translated.some(containsArabic)) return translated;
    } catch {
      // Continue to the next configured provider.
    }
  }
  return items;
}

export async function translateBroadcastStrings(
  values: readonly string[],
  config: LiveBroadcastConfig,
  maxItems = 80,
): Promise<string[]> {
  const normalized = values.slice(0, maxItems).map((value) => normalize(value));
  const output = [...normalized];
  const missingValues: string[] = [];
  const missingIndexes: number[] = [];

  normalized.forEach((value, index) => {
    if (!value || containsArabic(value)) {
      if (value) translationCache.set(value, value);
      return;
    }
    const cached = translationCache.get(value);
    if (cached) {
      output[index] = cached;
      return;
    }
    missingValues.push(value);
    missingIndexes.push(index);
  });

  for (let start = 0; start < missingValues.length; start += MAX_BATCH) {
    const batch = missingValues.slice(start, start + MAX_BATCH);
    const translated = await translateMissing(batch, config);
    batch.forEach((original, offset) => {
      const targetIndex = missingIndexes[start + offset];
      if (targetIndex === undefined) return;
      const value = normalize(translated[offset] || original);
      output[targetIndex] = value;
      if (containsArabic(value)) translationCache.set(original, value);
    });
  }

  while (translationCache.size > 800) {
    const oldest = translationCache.keys().next().value as string | undefined;
    if (!oldest) break;
    translationCache.delete(oldest);
  }
  return output;
}
