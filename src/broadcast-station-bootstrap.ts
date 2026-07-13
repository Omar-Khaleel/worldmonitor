import './styles/broadcast-station-hotfix.css';

async function waitForDashboardPanels(timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const grid = document.querySelector('#panelsGrid');
    const panelCount = document.querySelectorAll('#panelsGrid .panel[data-panel]').length;
    if (grid && panelCount > 0) return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
  }
}

export async function initBroadcastStationWhenReady(): Promise<void> {
  await waitForDashboardPanels();
  const module = await import('@/broadcast-station');
  module.prepareBroadcastLanguage();
  await module.initBroadcastStation();

  const params = new URL(window.location.href).searchParams;
  if (params.get('broadcast') === '1') {
    const translation = await import('@/broadcast-translation-hotfix');
    translation.initBroadcastTranslationHotfix();
  }
}
