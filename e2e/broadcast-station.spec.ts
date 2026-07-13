import { expect, test } from '@playwright/test';

function stationConfig(
  name: string,
  headline: string,
  panelTitle: string,
  panelItem: string,
  updatedAt = Date.now(),
) {
  return {
    version: 2,
    updatedAt,
    channelName: name,
    channelSubtitle: 'قناة الأخبار والمعلومات والتحليل',
    panelIds: ['politics'],
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
    panelSnapshots: [
      {
        id: 'politics',
        title: panelTitle,
        items: [panelItem],
        updatedAt,
      },
    ],
    tickerHeadlines: [headline],
    mediaSources: [],
    projectionUpdatedAt: updatedAt,
  };
}

test('isolated viewer receives changes without reload and remains viewer after refresh', async ({ page, request }) => {
  const station = `ayn-e2e-${Date.now().toString(36)}`;
  const controlKey = 'e2e-control-key-12345678901234567890';
  const firstConfig = stationConfig(
    'عين الصقر — الاختبار الأول',
    'خبر الاختبار الأول يظهر في الشريط مباشرة',
    'الأخبار السياسية الأولى',
    'تفاصيل اللوحة الأولى',
  );

  const firstWrite = await request.put(`/api/broadcast/state?station=${station}`, {
    data: { controlKey, config: firstConfig },
  });
  expect(firstWrite.ok()).toBeTruthy();

  await page.goto(`/broadcast/?station=${station}&lang=ar`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(new RegExp(`/broadcast/\\?station=${station}`));
  await expect(page.locator('#app')).toHaveCount(0);
  await expect(page.locator('.broadcast-control-room')).toHaveCount(0);
  await expect(page.locator('#aynBroadcastViewer')).toHaveCount(1);
  await expect(page.locator('.ayn-viewer-brand-copy strong')).toHaveText('عين الصقر — الاختبار الأول');
  await expect(page.locator('.ayn-ticker-track')).toContainText('خبر الاختبار الأول يظهر في الشريط مباشرة');
  await expect(page.locator('.ayn-panel-card[data-panel-id="politics"] h2')).toHaveText('الأخبار السياسية الأولى');
  await expect(page.locator('.ayn-panel-card[data-panel-id="politics"]')).toContainText('تفاصيل اللوحة الأولى');

  await page.evaluate(() => {
    (window as Window & { __aynNoReloadMarker?: string }).__aynNoReloadMarker = 'preserved';
  });

  const secondConfig = stationConfig(
    'عين الصقر — التحديث الثاني',
    'خبر التحديث الثاني وصل من دون إعادة تحميل الصفحة',
    'الأخبار السياسية المحدثة',
    'تفاصيل اللوحة المحدثة لحظياً',
    Date.now() + 10,
  );
  const secondWrite = await request.put(`/api/broadcast/state?station=${station}`, {
    data: { controlKey, config: secondConfig },
  });
  expect(secondWrite.ok()).toBeTruthy();

  await expect(page.locator('.ayn-viewer-brand-copy strong')).toHaveText('عين الصقر — التحديث الثاني');
  await expect(page.locator('.ayn-ticker-track')).toContainText('خبر التحديث الثاني وصل من دون إعادة تحميل الصفحة');
  await expect(page.locator('.ayn-panel-card[data-panel-id="politics"] h2')).toHaveText('الأخبار السياسية المحدثة');
  await expect(page.locator('.ayn-panel-card[data-panel-id="politics"]')).toContainText('تفاصيل اللوحة المحدثة لحظياً');
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __aynNoReloadMarker?: string }).__aynNoReloadMarker,
  )).toBe('preserved');

  const loadedScripts = await page.evaluate(() =>
    performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => /\\.js(?:$|\\?)/.test(name)),
  );
  expect(loadedScripts.some((name) => /\/assets\/(?:main|control)-/.test(name))).toBeFalsy();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(new RegExp(`/broadcast/\\?station=${station}`));
  await expect(page.locator('#app')).toHaveCount(0);
  await expect(page.locator('.broadcast-control-room')).toHaveCount(0);
  await expect(page.locator('.ayn-viewer-brand-copy strong')).toHaveText('عين الصقر — التحديث الثاني');
  await expect(page.locator('.ayn-ticker-track')).toContainText('خبر التحديث الثاني وصل من دون إعادة تحميل الصفحة');
});
