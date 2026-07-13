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

function forceControlActionsVisible(): void {
  const room = document.querySelector<HTMLElement>('#broadcastControlRoom');
  const body = room?.querySelector<HTMLElement>('.broadcast-control-body');
  const status = room?.querySelector<HTMLElement>('.broadcast-control-status');
  const actions = room?.querySelector<HTMLElement>('.broadcast-control-actions');
  if (!room || !actions) return;

  room.style.setProperty('display', 'flex', 'important');
  room.style.setProperty('flex-direction', 'column', 'important');
  room.style.setProperty('height', '100dvh', 'important');
  room.style.setProperty('overflow', 'hidden', 'important');

  body?.style.setProperty('flex', '1 1 auto', 'important');
  body?.style.setProperty('min-height', '0', 'important');
  body?.style.setProperty('overflow-y', 'auto', 'important');

  status?.style.setProperty('display', 'block', 'important');
  status?.style.setProperty('visibility', 'visible', 'important');
  status?.style.setProperty('opacity', '1', 'important');

  actions.style.setProperty('display', 'grid', 'important');
  actions.style.setProperty('visibility', 'visible', 'important');
  actions.style.setProperty('opacity', '1', 'important');
  actions.style.setProperty('pointer-events', 'auto', 'important');
  actions.style.setProperty('flex', '0 0 auto', 'important');

  actions.querySelectorAll<HTMLElement>('button').forEach((button) => {
    button.style.setProperty('display', 'block', 'important');
    button.style.setProperty('visibility', 'visible', 'important');
    button.style.setProperty('opacity', '1', 'important');
    button.style.setProperty('pointer-events', 'auto', 'important');
  });
}

export async function initBroadcastStationWhenReady(): Promise<void> {
  await waitForDashboardPanels();
  const module = await import('@/broadcast-station');
  module.prepareBroadcastLanguage();
  await module.initBroadcastStation();

  const params = new URL(window.location.href).searchParams;
  if (params.get('control') === '1') {
    forceControlActionsVisible();
    window.setTimeout(forceControlActionsVisible, 500);
  }

  if (params.get('broadcast') === '1') {
    const translation = await import('@/broadcast-translation-hotfix');
    translation.initBroadcastTranslationHotfix();
  }
}
