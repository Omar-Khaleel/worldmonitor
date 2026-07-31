import { loadLiveConfig, subscribeLiveConfig, type LiveBroadcastConfig } from '@/broadcast-sync';

let clockTimer: number | null = null;

function create<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function ensureTicker(config: LiveBroadcastConfig): void {
  let ticker = document.querySelector<HTMLElement>('#broadcastTicker');
  if (!config.tickerEnabled) {
    if (ticker) ticker.style.setProperty('display', 'none', 'important');
    return;
  }

  if (!ticker) {
    ticker = create('div', 'broadcast-ticker');
    ticker.id = 'broadcastTicker';
    ticker.dir = 'rtl';

    const label = create('div', 'broadcast-ticker-label');
    label.append(create('span', 'broadcast-ticker-pulse'), create('strong', '', 'آخر الأخبار'));
    const viewport = create('div', 'broadcast-ticker-viewport');
    const track = create('div', 'broadcast-ticker-track');
    track.id = 'broadcastTickerTrack';
    viewport.appendChild(track);
    const clock = create('time', 'broadcast-ticker-clock');
    ticker.append(label, viewport, clock);
    document.body.appendChild(ticker);

    const updateClock = (): void => {
      clock.textContent = new Intl.DateTimeFormat('ar-IQ', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).format(new Date());
    };
    updateClock();
    if (clockTimer !== null) window.clearInterval(clockTimer);
    clockTimer = window.setInterval(updateClock, 1000);
  }

  ticker.style.setProperty('display', 'grid', 'important');
}

export function initBroadcastTickerShell(): void {
  const params = new URL(window.location.href).searchParams;
  if (params.get('broadcast') !== '1') return;
  ensureTicker(loadLiveConfig());
  subscribeLiveConfig(ensureTicker);
}
