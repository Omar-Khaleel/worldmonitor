import './styles/broadcast-launcher.css';

const LAUNCHER_ID = 'aynBroadcastLauncher';

function buildControlUrl(): string {
  const url = new URL(window.location.href);
  url.pathname = '/control/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function mountBroadcastLauncher(): void {
  const params = new URL(window.location.href).searchParams;
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (params.get('control') === '1' || params.get('broadcast') === '1') return;
  if (path === '/control' || path === '/broadcast' || path === '/station') return;
  if (document.getElementById(LAUNCHER_ID)) return;

  const button = document.createElement('button');
  button.id = LAUNCHER_ID;
  button.type = 'button';
  button.className = 'ayn-broadcast-launcher';
  button.dir = 'rtl';
  button.setAttribute('aria-label', 'فتح غرفة تحكم عين الصقر');
  button.title = 'فتح غرفة تحكم محطة عين الصقر';

  const mark = document.createElement('span');
  mark.className = 'ayn-broadcast-launcher-mark';
  mark.textContent = '◉';

  const copy = document.createElement('span');
  copy.className = 'ayn-broadcast-launcher-copy';

  const name = document.createElement('strong');
  name.textContent = 'عين الصقر';
  const subtitle = document.createElement('small');
  subtitle.textContent = 'غرفة التحكم والبث';
  copy.append(name, subtitle);

  button.append(mark, copy);
  button.addEventListener('click', () => window.location.assign(buildControlUrl()));
  document.body.appendChild(button);

  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      window.location.assign(buildControlUrl());
    }
  });
}
