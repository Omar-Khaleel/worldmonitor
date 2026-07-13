import { DEFAULT_MAP_LAYERS } from '@/config';
import { OPTIONAL_LIVE_CHANNELS, getDefaultLiveChannels, type LiveChannel } from '@/components/LiveNewsPanel';
import {
  buildLiveViewerUrl,
  getStationId,
  loadLiveConfig,
  publishLiveConfig,
  type LiveBroadcastConfig,
} from '@/broadcast-sync';

interface WebcamSource {
  id: string;
  city: string;
  country: string;
  region: string;
  fallbackVideoId: string;
}

export const BROADCAST_WEBCAMS: WebcamSource[] = [
  { id: 'jerusalem', city: 'القدس', country: 'فلسطين', region: 'الشرق الأوسط', fallbackVideoId: 'e34xb-Fbl0U' },
  { id: 'middle-east', city: 'الشرق الأوسط', country: 'متعدد', region: 'الشرق الأوسط', fallbackVideoId: 'oxT5R6I0N6E' },
  { id: 'tel-aviv', city: 'تل أبيب', country: 'إسرائيل', region: 'الشرق الأوسط', fallbackVideoId: 'gmtlJ_m2r5A' },
  { id: 'mecca', city: 'مكة المكرمة', country: 'السعودية', region: 'الشرق الأوسط', fallbackVideoId: 'kJwEsQTegxk' },
  { id: 'beirut-mtv', city: 'بيروت', country: 'لبنان', region: 'الشرق الأوسط', fallbackVideoId: 'djF-Lkgfp6k' },
  { id: 'kyiv', city: 'كييف', country: 'أوكرانيا', region: 'أوروبا', fallbackVideoId: '-Q7FuPINDjA' },
  { id: 'odessa', city: 'أوديسا', country: 'أوكرانيا', region: 'أوروبا', fallbackVideoId: 'e2gC37ILQmk' },
  { id: 'paris', city: 'باريس', country: 'فرنسا', region: 'أوروبا', fallbackVideoId: 'OzYp4NRZlwQ' },
  { id: 'st-petersburg', city: 'سانت بطرسبرغ', country: 'روسيا', region: 'أوروبا', fallbackVideoId: 'CjtIYbmVfck' },
  { id: 'london', city: 'لندن', country: 'بريطانيا', region: 'أوروبا', fallbackVideoId: 'Lxqcg1qt0XU' },
  { id: 'washington', city: 'واشنطن', country: 'الولايات المتحدة', region: 'الأمريكيتان', fallbackVideoId: '1wV9lLe14aU' },
  { id: 'new-york', city: 'نيويورك', country: 'الولايات المتحدة', region: 'الأمريكيتان', fallbackVideoId: '4qyZLflp-sI' },
  { id: 'los-angeles', city: 'لوس أنجلوس', country: 'الولايات المتحدة', region: 'الأمريكيتان', fallbackVideoId: 'EO_1LWqsCNE' },
  { id: 'miami', city: 'ميامي', country: 'الولايات المتحدة', region: 'الأمريكيتان', fallbackVideoId: '5YCajRjvWCg' },
  { id: 'taipei', city: 'تايبيه', country: 'تايوان', region: 'آسيا', fallbackVideoId: 'z_fY1pj1VBw' },
  { id: 'shanghai', city: 'شنغهاي', country: 'الصين', region: 'آسيا', fallbackVideoId: '76EwqI5XZIc' },
  { id: 'tokyo', city: 'طوكيو', country: 'اليابان', region: 'آسيا', fallbackVideoId: '_k-5U7IeK8g' },
  { id: 'seoul', city: 'سيول', country: 'كوريا الجنوبية', region: 'آسيا', fallbackVideoId: '-JhoMGoAfFc' },
  { id: 'sydney', city: 'سيدني', country: 'أستراليا', region: 'آسيا والمحيط الهادئ', fallbackVideoId: '7pcL-0Wo77U' },
  { id: 'iss-earth', city: 'مشهد الأرض من المحطة الدولية', country: 'الفضاء', region: 'الفضاء', fallbackVideoId: 'vytmBNhc9ig' },
  { id: 'nasa-live', city: 'تلفزيون ناسا', country: 'الفضاء', region: 'الفضاء', fallbackVideoId: 'zPH5KtjJFaQ' },
];

const MAP_LABELS: Record<string, string> = {
  conflicts: 'مناطق الصراع', hotspots: 'النقاط الساخنة', sanctions: 'العقوبات', weather: 'الطقس',
  economic: 'المؤشرات الاقتصادية', waterways: 'الممرات المائية', outages: 'الانقطاعات', military: 'النشاط العسكري',
  natural: 'الكوارث الطبيعية', bases: 'القواعد العسكرية', cables: 'الكابلات البحرية', pipelines: 'خطوط الأنابيب',
  nuclear: 'المنشآت النووية', flights: 'حركة الطيران', protests: 'الاحتجاجات', fires: 'الحرائق',
  cyberThreats: 'التهديدات السيبرانية', datacenters: 'مراكز البيانات', ais: 'حركة السفن', diseaseOutbreaks: 'تفشي الأمراض',
  displacement: 'النزوح', climate: 'المناخ', ucdpEvents: 'أحداث الصراع المسلح', storageFacilities: 'مرافق التخزين',
  fuelShortages: 'نقص الوقود', radiationWatch: 'مراقبة الإشعاع', dayNight: 'الليل والنهار', tradeRoutes: 'طرق التجارة',
};

const PANEL_GROUPS: Array<[RegExp, string]> = [
  [/live-news|live-webcams|windy-webcams|stream|camera|webcam/i, 'البث المباشر والكاميرات'],
  [/politics|us|europe|middleeast|africa|latam|asia|gov|thinktanks|climate-news/i, 'الأخبار العالمية والإقليمية'],
  [/insights|strategic|intel|threat|risk|forecast|deduction|cross-source|regional/i, 'التحليل والاستخبارات'],
  [/market|finance|economic|energy|oil|gold|stock|crypto|trade|supply|commodity/i, 'الاقتصاد والأسواق والطاقة'],
  [/security|cyber|military|sanctions|radiation|airline|defense/i, 'الأمن والدفاع'],
];

let publishTimer: number | null = null;

function uniqueChannels(): LiveChannel[] {
  const map = new Map<string, LiveChannel>();
  for (const channel of [...getDefaultLiveChannels(), ...OPTIONAL_LIVE_CHANNELS]) map.set(channel.id, channel);
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function makeSection(title: string, hint?: string): HTMLElement {
  const section = document.createElement('section');
  section.className = 'ayn-control-section';
  const heading = document.createElement('h3');
  heading.className = 'broadcast-control-section-title';
  heading.textContent = title;
  section.appendChild(heading);
  if (hint) {
    const copy = document.createElement('p');
    copy.className = 'ayn-control-hint';
    copy.textContent = hint;
    section.appendChild(copy);
  }
  return section;
}

function makeCheck(id: string, label: string, checked: boolean, group: string): HTMLLabelElement {
  const row = document.createElement('label');
  row.className = 'ayn-source-option';
  row.dataset.search = `${id} ${label}`.toLowerCase();
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = checked;
  input.dataset.aynGroup = group;
  const span = document.createElement('span');
  span.textContent = label;
  const code = document.createElement('code');
  code.textContent = id.replace(/^ayn-(channel|webcam|layer)-/, '');
  row.append(input, span, code);
  return row;
}

function checkedValues(room: HTMLElement, group: string): string[] {
  return Array.from(room.querySelectorAll<HTMLInputElement>(`input[data-ayn-group='${group}']:checked`))
    .map((input) => input.value || input.id.replace(`ayn-${group}-`, ''));
}

function valueOf<T extends HTMLInputElement | HTMLSelectElement>(room: HTMLElement, id: string): T | null {
  return room.querySelector<T>(`#${id}`);
}

function readFullConfig(room: HTMLElement): LiveBroadcastConfig {
  const base = loadLiveConfig();
  const panelIds = Array.from(room.querySelectorAll<HTMLInputElement>("input[id^='broadcast-panel-']:checked"))
    .map((input) => input.id.replace('broadcast-panel-', ''));
  const selectedChannels = checkedValues(room, 'channel');
  const selectedWebcams = checkedValues(room, 'webcam');
  const selectedLayers = checkedValues(room, 'layer');

  return {
    ...base,
    version: 2,
    updatedAt: Date.now(),
    channelName: valueOf<HTMLInputElement>(room, 'broadcast-channel-name')?.value || base.channelName,
    channelSubtitle: valueOf<HTMLInputElement>(room, 'broadcast-channel-subtitle')?.value || base.channelSubtitle,
    panelIds,
    showMap: valueOf<HTMLInputElement>(room, 'broadcast-show-map')?.checked !== false,
    columns: Number(valueOf<HTMLSelectElement>(room, 'broadcast-columns')?.value || base.columns) as 1 | 2 | 3 | 4,
    gapPx: Number(valueOf<HTMLInputElement>(room, 'broadcast-gap')?.value || base.gapPx),
    tickerEnabled: valueOf<HTMLInputElement>(room, 'broadcast-ticker-enabled')?.checked !== false,
    tickerSpeedSeconds: Number(valueOf<HTMLInputElement>(room, 'broadcast-ticker-speed')?.value || base.tickerSpeedSeconds),
    tickerLimit: Number(valueOf<HTMLInputElement>(room, 'broadcast-ticker-limit')?.value || base.tickerLimit),
    forceArabic: true,
    translatePanelHeadlines: valueOf<HTMLInputElement>(room, 'broadcast-translate-panels')?.checked !== false,
    translationMode: (valueOf<HTMLSelectElement>(room, 'broadcast-translation-mode')?.value || base.translationMode) as LiveBroadcastConfig['translationMode'],
    ollamaUrl: valueOf<HTMLInputElement>(room, 'broadcast-ollama-url')?.value || base.ollamaUrl,
    ollamaModel: valueOf<HTMLInputElement>(room, 'broadcast-ollama-model')?.value || base.ollamaModel,
    liveChannelIds: selectedChannels,
    webcamIds: selectedWebcams,
    mapLayerIds: selectedLayers,
    mediaColumns: Number(valueOf<HTMLSelectElement>(room, 'ayn-media-columns')?.value || base.mediaColumns) as 1 | 2 | 3 | 4,
    showMediaWall: valueOf<HTMLInputElement>(room, 'ayn-show-media-wall')?.checked !== false,
  };
}

function publishNow(room: HTMLElement, status: HTMLElement): LiveBroadcastConfig {
  const config = publishLiveConfig(readFullConfig(room));
  status.textContent = `نُشرت الإعدادات مباشرة — المحطة: ${getStationId()} — ${new Date().toLocaleTimeString('ar-IQ')}`;
  return config;
}

function schedulePublish(room: HTMLElement, status: HTMLElement): void {
  status.textContent = 'جارٍ نشر التغيير مباشرة...';
  if (publishTimer !== null) window.clearTimeout(publishTimer);
  publishTimer = window.setTimeout(() => {
    publishTimer = null;
    publishNow(room, status);
  }, 220);
}

function addSearch(section: HTMLElement, list: HTMLElement, placeholder: string): void {
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'ayn-control-search';
  search.placeholder = placeholder;
  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    list.querySelectorAll<HTMLElement>('[data-search]').forEach((row) => {
      row.hidden = Boolean(query) && !(row.dataset.search || '').includes(query);
    });
  });
  section.append(search, list);
}

function enhancePanelList(room: HTMLElement): void {
  const list = room.querySelector<HTMLElement>('.broadcast-panel-list');
  if (!list || list.dataset.aynEnhanced === 'true') return;
  list.dataset.aynEnhanced = 'true';
  list.querySelectorAll<HTMLElement>('.broadcast-panel-option').forEach((row) => {
    const id = row.querySelector('code')?.textContent || '';
    const title = row.querySelector('.broadcast-panel-option-title')?.textContent || id;
    const group = PANEL_GROUPS.find(([pattern]) => pattern.test(id))?.[1] || 'بيانات وواجهات API أخرى';
    row.dataset.group = group;
    row.dataset.search = `${id} ${title} ${group}`.toLowerCase();
    const badge = document.createElement('small');
    badge.className = 'ayn-panel-group-badge';
    badge.textContent = group;
    row.appendChild(badge);
  });
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'ayn-control-search';
  search.placeholder = 'البحث في الأخبار والتحليلات والـ API...';
  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    list.querySelectorAll<HTMLElement>('.broadcast-panel-option').forEach((row) => {
      row.hidden = Boolean(query) && !(row.dataset.search || '').includes(query);
    });
  });
  list.parentElement?.insertBefore(search, list);
}

function replaceActions(room: HTMLElement, status: HTMLElement): void {
  const actions = room.querySelector<HTMLElement>('.broadcast-control-actions');
  if (!actions || actions.dataset.aynLive === 'true') return;
  actions.dataset.aynLive = 'true';

  actions.addEventListener('click', async (event) => {
    const button = (event.target as HTMLElement).closest('button');
    if (!button) return;
    const text = button.textContent?.trim() || '';
    if (!/حفظ|فتح شاشة المشاهد|نسخ رابط البث/.test(text)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const config = publishNow(room, status);
    const url = buildLiveViewerUrl();
    if (text.includes('فتح')) {
      window.open(url, '_blank', 'noopener,noreferrer');
    } else if (text.includes('نسخ')) {
      try {
        await navigator.clipboard.writeText(url);
        status.textContent = `تم نسخ رابط حي ثابت. كل تغيير يصل إليه مباشرة: ${url}`;
      } catch {
        status.textContent = url;
      }
    } else {
      status.textContent = `تم النشر الفوري بنجاح — ${config.panelIds.length} شاشة و${config.liveChannelIds.length + config.webcamIds.length} مصدر بث.`;
    }
  }, true);
}

export function initBroadcastControlEnhancements(): void {
  const params = new URL(window.location.href).searchParams;
  if (params.get('control') !== '1') return;
  const room = document.querySelector<HTMLElement>('#broadcastControlRoom');
  const body = room?.querySelector<HTMLElement>('.broadcast-control-body');
  const status = room?.querySelector<HTMLElement>('.broadcast-control-status');
  if (!room || !body || !status || room.dataset.aynFullControl === 'true') return;
  room.dataset.aynFullControl = 'true';

  const config = loadLiveConfig();
  const liveSection = makeSection('الربط المباشر مع شاشة المشاهد', 'الرابط ثابت، وكل تغيير في هذه الغرفة يُرسل تلقائياً من دون تحديث صفحة المشاهد.');
  const liveUrl = document.createElement('input');
  liveUrl.className = 'ayn-live-url';
  liveUrl.readOnly = true;
  liveUrl.dir = 'ltr';
  liveUrl.value = buildLiveViewerUrl();
  const station = document.createElement('div');
  station.className = 'ayn-sync-indicator';
  station.innerHTML = `<span></span><strong>المحطة ${getStationId()}</strong><small>مزامنة محلية وفحص الخادم كل ثانية</small>`;
  liveSection.append(station, liveUrl);

  const mediaSection = makeSection('جدار القنوات والكاميرات المباشرة', 'اختر عدة قنوات وكاميرات لتظهر كجدار بث صامت ونظيف للمشاهد.');
  const showWall = document.createElement('label');
  showWall.className = 'broadcast-control-check';
  const showWallInput = document.createElement('input');
  showWallInput.type = 'checkbox';
  showWallInput.id = 'ayn-show-media-wall';
  showWallInput.checked = config.showMediaWall;
  showWall.append(showWallInput, document.createTextNode('إظهار جدار البث المرئي'));
  const mediaColumns = document.createElement('select');
  mediaColumns.id = 'ayn-media-columns';
  for (const value of [1, 2, 3, 4]) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = `${value} ${value === 1 ? 'عمود' : 'أعمدة'}`;
    option.selected = config.mediaColumns === value;
    mediaColumns.appendChild(option);
  }
  const mediaField = document.createElement('label');
  mediaField.className = 'broadcast-control-field';
  mediaField.innerHTML = '<span class="broadcast-control-label">أعمدة جدار البث</span>';
  mediaField.appendChild(mediaColumns);
  mediaSection.append(showWall, mediaField);

  const channelSection = makeSection('القنوات الإخبارية المباشرة');
  const channelList = document.createElement('div');
  channelList.className = 'ayn-source-list';
  const selectedChannels = new Set(config.liveChannelIds.length ? config.liveChannelIds : ['alarabiya', 'aljazeera-arabic']);
  for (const channel of uniqueChannels()) {
    const row = makeCheck(`ayn-channel-${channel.id}`, channel.name, selectedChannels.has(channel.id), 'channel');
    const input = row.querySelector('input')!;
    input.value = channel.id;
    channelList.appendChild(row);
  }
  addSearch(channelSection, channelList, 'ابحث عن قناة: العربية، الجزيرة، BBC، CNN...');

  const webcamSection = makeSection('كاميرات الويب والمشاهد المباشرة');
  const webcamList = document.createElement('div');
  webcamList.className = 'ayn-source-list';
  const selectedWebcams = new Set(config.webcamIds.length ? config.webcamIds : ['jerusalem', 'middle-east']);
  for (const webcam of BROADCAST_WEBCAMS) {
    const row = makeCheck(`ayn-webcam-${webcam.id}`, `${webcam.city} — ${webcam.country}`, selectedWebcams.has(webcam.id), 'webcam');
    const input = row.querySelector('input')!;
    input.value = webcam.id;
    webcamList.appendChild(row);
  }
  addSearch(webcamSection, webcamList, 'ابحث عن مدينة أو كاميرا مباشرة...');

  const layerSection = makeSection('طبقات الخريطة ومصادر البيانات', 'هذه الخيارات تتحكم بطبقات البيانات التي تعرضها الخريطة في شاشة المشاهد.');
  const layerList = document.createElement('div');
  layerList.className = 'ayn-source-list ayn-layer-list';
  const defaults = Object.entries(DEFAULT_MAP_LAYERS).filter(([, enabled]) => enabled).map(([key]) => key);
  const selectedLayers = new Set(config.mapLayerIds.length ? config.mapLayerIds : defaults);
  for (const key of Object.keys(DEFAULT_MAP_LAYERS)) {
    const row = makeCheck(`ayn-layer-${key}`, MAP_LABELS[key] || key, selectedLayers.has(key), 'layer');
    const input = row.querySelector('input')!;
    input.value = key;
    layerList.appendChild(row);
  }
  addSearch(layerSection, layerList, 'ابحث عن طبقة أو مصدر بيانات...');

  const firstTitle = body.querySelector('.broadcast-control-section-title');
  const insertBefore = firstTitle || body.firstChild;
  for (const section of [liveSection, mediaSection, channelSection, webcamSection, layerSection]) {
    body.insertBefore(section, insertBefore);
  }

  enhancePanelList(room);
  replaceActions(room, status);

  room.addEventListener('input', () => schedulePublish(room, status));
  room.addEventListener('change', () => schedulePublish(room, status));
  window.addEventListener('ayn-broadcast-sync-status', (event) => {
    const detail = (event as CustomEvent<{ state?: string; detail?: string }>).detail;
    station.dataset.state = detail?.state || 'local';
    const small = station.querySelector('small');
    if (small) small.textContent = detail?.state === 'online' ? 'متصل — يصل التحديث إلى الرابط مباشرة' : 'المعاينة المحلية فعالة — خادم الربط غير متاح';
  });

  publishNow(room, status);
}
