import './styles/broadcast-viewer-polish.css';

let observer: MutationObserver | null = null;
let debounceTimer: number | null = null;

const CONTROL_SELECTOR = [
  'button',
  'select',
  'input',
  '[role="button"]',
  '[role="toolbar"]',
  '[role="tablist"]',
  '[class*="toolbar" i]',
  '[class*="selector" i]',
  '[class*="switcher" i]',
  '[class*="control" i]',
  '[class*="filter" i]',
].join(',');

const MEDIA_PANEL_PATTERN = /live-news|live-webcams|windy-webcams|webcam|camera|stream|video|tv/i;
const LABEL_CLASS_PATTERN = /(webcam|camera|channel|stream).*(name|title|label|city|country|location|meta|caption)|(name|title|label|city|country|location|meta|caption).*(webcam|camera|channel|stream)/i;

function forceHidden(element: HTMLElement): void {
  element.setAttribute('aria-hidden', 'true');
  element.style.setProperty('display', 'none', 'important');
  element.style.setProperty('visibility', 'hidden', 'important');
  element.style.setProperty('pointer-events', 'none', 'important');
}

function cleanMapViewer(): void {
  const map = document.querySelector<HTMLElement>('#mapSection');
  if (!map) return;

  map.querySelectorAll<HTMLElement>(CONTROL_SELECTOR).forEach(forceHidden);
  map.querySelectorAll<HTMLElement>(
    '[class*="layer" i], [class*="legend" i], [class*="timeline" i], [class*="time-range" i], .mapboxgl-ctrl, .maplibregl-ctrl',
  ).forEach((element) => {
    if (element.querySelector('canvas, iframe, video')) return;
    forceHidden(element);
  });
}

function cleanMediaPanel(panel: HTMLElement): void {
  const id = panel.dataset.panel || '';
  const title = panel.querySelector<HTMLElement>('.panel-title')?.textContent || '';
  if (!MEDIA_PANEL_PATTERN.test(`${id} ${title}`)) return;

  panel.style.setProperty('pointer-events', 'none', 'important');

  panel.querySelectorAll<HTMLElement>(CONTROL_SELECTOR).forEach((element) => {
    if (element.closest('.broadcast-ticker, .broadcast-channel-bug')) return;
    forceHidden(element);
  });

  panel.querySelectorAll<HTMLElement>('[class]').forEach((element) => {
    const className = typeof element.className === 'string' ? element.className : '';
    if (!LABEL_CLASS_PATTERN.test(className)) return;
    if (element.matches('iframe, video, canvas, img') || element.querySelector('iframe, video, canvas, img')) return;
    forceHidden(element);
  });

  panel.querySelectorAll<HTMLVideoElement>('video').forEach((video) => {
    video.controls = false;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('disablepictureinpicture', '');
    void video.play().catch(() => {});
  });

  panel.querySelectorAll<HTMLIFrameElement>('iframe').forEach((iframe) => {
    iframe.tabIndex = -1;
    iframe.setAttribute('aria-hidden', 'true');
  });
}

function cleanViewer(): void {
  if (!document.body.classList.contains('broadcast-viewer')) return;
  cleanMapViewer();
  document.querySelectorAll<HTMLElement>('#panelsGrid .panel[data-panel]').forEach(cleanMediaPanel);
}

function scheduleClean(delay = 250): void {
  if (debounceTimer !== null) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    cleanViewer();
  }, delay);
}

export function initBroadcastViewerPolish(): void {
  const params = new URL(window.location.href).searchParams;
  if (params.get('broadcast') !== '1') return;
  if (document.body.dataset.aynViewerPolish === '1') return;
  document.body.dataset.aynViewerPolish = '1';

  cleanViewer();
  window.setTimeout(cleanViewer, 800);
  window.setTimeout(cleanViewer, 2500);

  observer?.disconnect();
  observer = new MutationObserver(() => scheduleClean(350));
  observer.observe(document.body, { childList: true, subtree: true });
}
