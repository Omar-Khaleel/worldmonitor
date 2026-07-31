async function bootControlRoom(): Promise<void> {
  const url = new URL(window.location.href);
  url.searchParams.set('control', '1');
  url.searchParams.set('lang', 'ar');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  document.documentElement.lang = 'ar';
  document.documentElement.dir = 'rtl';
  document.body.dataset.aynEntry = 'control';

  await import('@/main');
  const projection = await import('@/broadcast-control-projection');
  await projection.initBroadcastControlProjection();
}

void bootControlRoom().catch((error) => {
  console.error('[عين الصقر] Failed to boot control room', error);
  document.body.textContent = 'تعذر تشغيل غرفة التحكم. راجع سجل المتصفح.';
});
