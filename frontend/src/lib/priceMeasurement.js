const utcTime = time => {
  if (typeof time === 'number') return time * 1000;
  if (typeof time === 'string') return Date.parse(time);
  if (time && typeof time === 'object') return Date.UTC(time.year, time.month - 1, time.day);
  return NaN;
};
export function measurementDate(time) {
  const stamp = utcTime(time);
  return Number.isFinite(stamp) ? new Date(stamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';
}
export function priceMeasurement(start, end) {
  if (!start || !end || !Number.isFinite(start.price) || start.price <= 0 || !Number.isFinite(end.price)) return null;
  const change = end.price - start.price;
  const from = utcTime(start.time), to = utcTime(end.time);
  return {
    change, percent: change / start.price * 100,
    bars: Number.isFinite(start.logical) && Number.isFinite(end.logical) ? Math.abs(Math.round(end.logical) - Math.round(start.logical)) : null,
    days: Number.isFinite(from) && Number.isFinite(to) ? Math.round(Math.abs(to - from) / 86400000) : null,
  };
}

// Points retain chart time + price, not pixels, so a completed measurement
// stays attached to its chosen levels when the user pans, zooms or resizes.
export function createPriceMeasurement(chart, series, element, onChange) {
  const timeScale = chart.timeScale();
  const win = element.ownerDocument.defaultView;
  const previousCursor = element.style.cursor;
  let active = false, start = null, end = null, preview = null;
  let savedControls = null, frame = null, disposed = false;
  const restoreControls = () => {
    if (savedControls) chart.applyOptions(savedControls);
    savedControls = null;
    element.style.cursor = previousCursor;
  };
  const publish = () => {
    if (disposed) return;
    const target = end || preview;
    const width = timeScale.width(), height = element.clientHeight - timeScale.height();
    const project = point => point && ({ x: timeScale.timeToCoordinate(point.time), y: series.priceToCoordinate(point.price) });
    const from = project(start), to = project(target);
    const valid = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
    onChange({ active, start, end, preview, result: priceMeasurement(start, target),
      geometry: valid(from) ? { from, to: valid(to) ? to : null, width, height } : null });
  };
  const schedule = () => {
    if (!start || disposed || frame != null) return;
    frame = win.requestAnimationFrame(() => { frame = null; publish(); });
  };
  const pointAt = event => {
    const p = event.point;
    if (!p || event.time == null || p.x < 0 || p.x >= timeScale.width() || p.y < 0 || p.y >= element.clientHeight - timeScale.height()) return null;
    const price = series.coordinateToPrice(p.y);
    return Number.isFinite(price) ? { time: event.time, logical: event.logical, price } : null;
  };
  const clear = () => { active = false; start = end = preview = null; restoreControls(); publish(); };
  const onClick = event => {
    if (!active) return;
    const point = pointAt(event);
    if (!point || (!start && point.price <= 0)) return;
    if (!start) start = point;
    else { end = point; preview = null; active = false; restoreControls(); }
    publish();
  };
  const onMove = event => {
    if (active && start && !end) preview = pointAt(event) || preview;
    if (start) publish();
  };
  const onKey = event => {
    if (event.key !== 'Escape' || event.target?.matches?.('input, textarea, select, [contenteditable="true"]')) return;
    if (active || start) { event.preventDefault(); clear(); }
  };
  chart.subscribeClick(onClick);
  chart.subscribeCrosshairMove(onMove);
  timeScale.subscribeVisibleLogicalRangeChange(schedule);
  timeScale.subscribeSizeChange(schedule);
  // Price-axis zoom has no range-change event. Reproject after native pointer
  // or wheel interaction as well, including when the RSI pane changes a range.
  for (const name of ['pointermove', 'pointerup', 'wheel']) element.addEventListener(name, schedule, { passive: true });
  win.addEventListener('keydown', onKey);
  publish();
  return {
    isActive: () => active,
    clear,
    toggle() {
      if (active) { clear(); return; }
      start = end = preview = null;
      const options = chart.options();
      savedControls = JSON.parse(JSON.stringify({ handleScroll: options.handleScroll, handleScale: options.handleScale }));
      chart.applyOptions({ handleScroll: false, handleScale: false });
      element.style.cursor = 'crosshair';
      active = true;
      publish();
    },
    dispose() {
      disposed = true;
      if (frame != null) win.cancelAnimationFrame(frame);
      restoreControls();
      chart.unsubscribeClick(onClick);
      chart.unsubscribeCrosshairMove(onMove);
      timeScale.unsubscribeVisibleLogicalRangeChange(schedule);
      timeScale.unsubscribeSizeChange(schedule);
      for (const name of ['pointermove', 'pointerup', 'wheel']) element.removeEventListener(name, schedule);
      win.removeEventListener('keydown', onKey);
    },
  };
}
