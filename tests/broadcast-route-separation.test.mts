import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function text(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('broadcast viewer has a dedicated lightweight HTML and JavaScript entry', async () => {
  const [viewerHtml, viewerEntry, controlHtml, controlEntry] = await Promise.all([
    text('broadcast/index.html'),
    text('src/broadcast-viewer-entry.ts'),
    text('control/index.html'),
    text('src/control-entry.ts'),
  ]);

  assert.match(viewerHtml, /src="\/src\/broadcast-viewer-entry\.ts"/);
  assert.doesNotMatch(viewerHtml, /src="\/src\/main\.ts"/);
  assert.doesNotMatch(viewerHtml, /id="app"/);
  assert.doesNotMatch(viewerEntry, /from ['"]\.\/App|from ['"]@\/App|new App\(/);
  assert.doesNotMatch(viewerEntry, /broadcast-control-enhancements|LiveNewsPanel/);
  assert.match(viewerEntry, /subscribeLiveConfig/);
  assert.match(viewerEntry, /panelSnapshots/);
  assert.match(viewerEntry, /tickerHeadlines/);

  assert.match(controlHtml, /id="app"/);
  assert.match(controlHtml, /src="\/src\/control-entry\.ts"/);
  assert.match(controlEntry, /import\(['"]@\/main['"]\)/);
  assert.match(controlEntry, /initBroadcastControlProjection/);
});

test('Vite and Vercel route refreshes to dedicated control and viewer documents', async () => {
  const [viteConfig, vercelRaw, metaTags, syncSource] = await Promise.all([
    text('vite.config.ts'),
    text('vercel.json'),
    text('src/services/meta-tags.ts'),
    text('src/broadcast-sync.ts'),
  ]);
  const vercel = JSON.parse(vercelRaw) as {
    rewrites: Array<{ source: string; destination: string }>;
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };

  assert.match(viteConfig, /control:\s*resolve\(__dirname, ['"]control\/index\.html['"]\)/);
  assert.match(viteConfig, /broadcast:\s*resolve\(__dirname, ['"]broadcast\/index\.html['"]\)/);
  assert.match(viteConfig, /broadcastStationDevPlugin\(\)/);

  const controlRewrite = vercel.rewrites.find((entry) => entry.source === '/control');
  const viewerRewrite = vercel.rewrites.find((entry) => entry.source === '/broadcast');
  assert.equal(controlRewrite?.destination, '/control/index.html');
  assert.equal(viewerRewrite?.destination, '/broadcast/index.html');

  const catchAll = vercel.rewrites.find((entry) => entry.destination === '/dashboard.html' && entry.source.includes('(?!'));
  assert.ok(catchAll, 'dashboard catch-all rewrite must exist');
  assert.match(catchAll!.source, /broadcast\|control\|api/);

  const viewerHeaders = vercel.headers.find((entry) => entry.source === '/broadcast/(.*)');
  assert.ok(viewerHeaders?.headers.some((header) => header.key === 'Cache-Control' && /no-store/.test(header.value)));

  assert.match(metaTags, /url\.pathname = mode === 'control' \? '\/control\/' : '\/broadcast\/'/);
  assert.doesNotMatch(metaTags, /url\.pathname = '\/';\s*url\.searchParams\.set\(mode/);
  assert.match(syncSource, /url\.pathname = '\/broadcast\/'/);
});

test('service worker navigation cache excludes the isolated station routes', async () => {
  const viteConfig = await text('vite.config.ts');
  assert.ok(viteConfig.includes("!/^\\/(?:broadcast|control)(?:\\/|$)/.test(url.pathname)"));
  assert.match(viteConfig, /cacheName:\s*['"]html-navigation['"]/);
});
