#!/usr/bin/env node

const argumentsMap = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key?.startsWith('--')) continue;
  const value = process.argv[index + 1];
  argumentsMap.set(key.slice(2), value && !value.startsWith('--') ? value : 'true');
  if (value && !value.startsWith('--')) index += 1;
}

const base = new URL(argumentsMap.get('base') || 'http://127.0.0.1:3000');
const timeoutMs = Number(argumentsMap.get('timeout') || 12_000);
const station = `ayn-doctor-${Date.now().toString(36)}`;
const controlKey = `doctor-${crypto.randomUUID()}-${crypto.randomUUID()}`;
let failures = 0;
let warnings = 0;

function result(symbol, label, detail = '') {
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`${symbol} ${label}${suffix}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, init = {}, requestTimeout = timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeout);
  const started = performance.now();
  try {
    const response = await fetch(new URL(path, base), {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        Accept: 'application/json, text/html, application/xml;q=0.9, */*;q=0.8',
        ...(init.headers || {}),
      },
    });
    return { response, elapsed: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

async function check(label, operation, { optional = false } = {}) {
  try {
    const detail = await operation();
    result('✓', label, detail);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (optional) {
      warnings += 1;
      result('!', label, message);
    } else {
      failures += 1;
      result('✗', label, message);
    }
  }
}

console.log(`\nعين الصقر — فحص المحطة`);
console.log(`العنوان: ${base.origin}`);
console.log(`المحطة المؤقتة: ${station}\n`);

await check('غرفة التحكم منفصلة وتعمل', async () => {
  const { response, elapsed } = await request('/control/');
  const html = await response.text();
  assert(response.ok, `HTTP ${response.status}`);
  assert(/control-entry|assets\/control-/.test(html), 'ملف غرفة التحكم غير موجود');
  assert(!/id="aynBroadcastViewer"/.test(html), 'غرفة التحكم تعرض مستند المشاهد بالخطأ');
  return `${elapsed}ms`;
});

await check('صفحة المشاهد منفصلة بعد فتح الرابط', async () => {
  const { response, elapsed } = await request(`/broadcast?station=${encodeURIComponent(station)}&lang=ar`);
  const html = await response.text();
  assert(response.ok, `HTTP ${response.status}`);
  assert(/id="aynBroadcastViewer"/.test(html), 'عنصر المشاهد غير موجود');
  assert(/broadcast-viewer-entry|assets\/broadcast-/.test(html), 'مدخل المشاهد غير موجود');
  assert(!/id="app"|control-entry|src\/main\.ts/.test(html), 'تم تحميل مستند الإدارة داخل المشاهد');
  return `${elapsed}ms`;
});

let stateVersion = 0;
const headline = `خبر فحص مباشر ${new Date().toISOString()}`;
const config = {
  version: 2,
  updatedAt: Date.now(),
  channelName: 'عين الصقر — فحص التشغيل',
  channelSubtitle: 'قناة الأخبار والمعلومات والتحليل',
  panelIds: ['doctor-news'],
  showMap: false,
  columns: 2,
  gapPx: 6,
  tickerEnabled: true,
  tickerSpeedSeconds: 30,
  tickerLimit: 12,
  forceArabic: true,
  translatePanelHeadlines: true,
  translationMode: 'off',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen2.5:7b',
  liveChannelIds: [],
  webcamIds: [],
  mapLayerIds: [],
  mediaColumns: 2,
  showMediaWall: false,
  panelSnapshots: [{
    id: 'doctor-news',
    title: 'اختبار الأخبار',
    items: [headline],
    updatedAt: Date.now(),
  }],
  tickerHeadlines: [headline],
  mediaSources: [],
  projectionUpdatedAt: Date.now(),
};

await check('نشر إعدادات المحطة', async () => {
  const { response, elapsed } = await request(`/api/broadcast/state?station=${station}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ controlKey, config }),
  });
  const payload = await response.json().catch(() => ({}));
  assert(response.ok, `HTTP ${response.status}: ${JSON.stringify(payload)}`);
  assert(payload.ok === true, 'الخادم لم يؤكد الحفظ');
  stateVersion = Number(payload.version || 0);
  assert(Number.isFinite(stateVersion) && stateVersion > 0, 'إصدار الحالة غير صالح');
  return `${elapsed}ms`;
});

await check('قراءة الحالة والشريط من الخادم', async () => {
  const { response, elapsed } = await request(`/api/broadcast/state?station=${station}`);
  const payload = await response.json().catch(() => ({}));
  assert(response.ok, `HTTP ${response.status}`);
  assert(payload.config?.channelName === config.channelName, 'اسم القناة لم يُحفظ');
  assert(payload.config?.tickerHeadlines?.includes(headline), 'الخبر غير موجود في حالة الشريط');
  return `${elapsed}ms`;
});

await check('الفحص الشرطي للتحديثات يعمل', async () => {
  const { response, elapsed } = await request(`/api/broadcast/state?station=${station}&after=${stateVersion}`);
  assert(response.status === 204, `توقعت 204 وحصلت على ${response.status}`);
  return `${elapsed}ms`;
});

await check('مصدر RSS الاحتياطي متاح', async () => {
  const feed = 'https://feeds.bbci.co.uk/news/world/rss.xml';
  const { response, elapsed } = await request(`/api/rss-proxy?url=${encodeURIComponent(feed)}`, {}, 18_000);
  const text = await response.text();
  assert(response.ok, `HTTP ${response.status}`);
  assert(/<item[\s>]|<entry[\s>]/i.test(text), 'لم يتم العثور على أخبار داخل RSS');
  return `${elapsed}ms`;
}, { optional: true });

await check('خادم الترجمة المركزي', async () => {
  const { response, elapsed } = await request('/api/broadcast/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: ['خبر عربي تجريبي'] }),
  });
  if (response.status === 503) throw new Error('غير مهيأ؛ استخدم Ollama أو متغيرات مزود الترجمة');
  const payload = await response.json().catch(() => ({}));
  assert(response.ok, `HTTP ${response.status}`);
  assert(Array.isArray(payload.translations), 'استجابة الترجمة غير صالحة');
  return `${elapsed}ms`;
}, { optional: true });

await check('Ollama المحلي ونموذج qwen2.5:7b', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: controller.signal });
    assert(response.ok, `HTTP ${response.status}`);
    const payload = await response.json();
    const names = Array.isArray(payload.models) ? payload.models.map((model) => model.name || model.model) : [];
    assert(names.some((name) => String(name).startsWith('qwen2.5:7b')), 'Ollama يعمل لكن النموذج qwen2.5:7b غير مثبت');
    return 'جاهز';
  } finally {
    clearTimeout(timer);
  }
}, { optional: true });

console.log('\nالنتيجة');
console.log(`نجاح أساسي: ${failures === 0 ? 'نعم' : 'لا'}`);
console.log(`أخطاء: ${failures}`);
console.log(`تنبيهات اختيارية: ${warnings}`);
console.log(`غرفة التحكم: ${new URL(`/control/?station=${station}&lang=ar`, base)}`);
console.log(`شاشة المشاهد: ${new URL(`/broadcast/?station=${station}&lang=ar`, base)}\n`);

process.exitCode = failures === 0 ? 0 : 1;
