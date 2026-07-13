interface TranslationRequest {
  method?: string;
  body?: unknown;
}

interface TranslationResponse {
  setHeader(name: string, value: string): void;
  status(code: number): TranslationResponse;
  json(value: unknown): void;
  end(): void;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

const MAX_ITEMS = 30;
const MAX_ITEM_LENGTH = 320;
const MAX_CACHE_ENTRIES = 800;
const cache = new Map<string, string>();

function containsArabic(value: string): boolean {
  const letters = value.match(/[A-Za-z\u0600-\u06FF]/g) || [];
  if (letters.length === 0) return false;
  const arabic = value.match(/[\u0600-\u06FF]/g) || [];
  return arabic.length / letters.length >= 0.65;
}

function normalizeItems(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
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
      return values.map((value) => String(value || '').replace(/\s+/g, ' ').trim()).slice(0, expected);
    }
  } catch {
    // The provider may have wrapped an otherwise usable list in plain lines.
  }
  return cleaned
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, expected);
}

function trimCache(): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export default async function handler(req: TranslationRequest, res: TranslationResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const items = normalizeItems(req.body);
  if (items.length === 0) {
    res.status(400).json({ error: 'items_required' });
    return;
  }

  const baseUrl = process.env.BROADCAST_TRANSLATION_BASE_URL?.replace(/\/$/, '');
  const model = process.env.BROADCAST_TRANSLATION_MODEL;
  const apiKey = process.env.BROADCAST_TRANSLATION_API_KEY;
  if (!baseUrl || !model) {
    res.status(503).json({
      error: 'translation_provider_not_configured',
      required: ['BROADCAST_TRANSLATION_BASE_URL', 'BROADCAST_TRANSLATION_MODEL'],
    });
    return;
  }

  const translations = [...items];
  const missing: string[] = [];
  const missingIndexes: number[] = [];

  items.forEach((item, index) => {
    if (containsArabic(item)) {
      cache.set(item, item);
      return;
    }
    const cached = cache.get(item);
    if (cached) {
      translations[index] = cached;
      return;
    }
    missing.push(item);
    missingIndexes.push(index);
  });

  if (missing.length > 0) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'أنت محرر ومترجم أخبار عربي محترف. ترجم العناوين إلى العربية الفصحى الإخبارية بدقة، من دون حذف أسماء أو أرقام ومن دون إضافة رأي أو معلومات. أعد JSON فقط بالشكل {"translations":["..."]} وبنفس عدد وترتيب العناوين.',
          },
          { role: 'user', content: JSON.stringify({ items: missing }) },
        ],
      }),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      res.status(502).json({ error: 'translation_provider_failed', status: response.status, detail });
      return;
    }

    const payload = await response.json() as ChatCompletionResponse;
    const parsed = parseTranslations(payload.choices?.[0]?.message?.content || '', missing.length);
    missingIndexes.forEach((targetIndex, translatedIndex) => {
      const value = parsed[translatedIndex] || missing[translatedIndex] || '';
      translations[targetIndex] = value;
      cache.set(missing[translatedIndex]!, value);
    });
    trimCache();
  }

  res.status(200).json({ translations });
}
