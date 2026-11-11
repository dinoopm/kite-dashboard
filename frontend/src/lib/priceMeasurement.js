import { moveEndpoint, nearestEndpoint } from './measurementEdit.js';
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
  let active = false, start = null, end = null, preview = null, dragging = null;
  let savedControls = null, frame = null, disposed = false;
  const restoreControls = () => {
    if (savedControls) chart.applyOptions(savedControls);
    savedControls = null;
    element.style.cursor = previousCursor;
  };
  const project = point => point && ({ x: timeScale.timeToCoordinate(point.time), y: series.priceToCoordinate(point.price) });
  const publish = () => {
    if (disposed) return;
    const target = end || preview;
    const width = timeScale.width(), height = element.clientHeight - timeScale.height();
    const from = project(start), to = project(target);
    const valid = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
    onChange({ active, start, end, preview, dragging, result: priceMeasurement(start, target),
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
  const clear = () => { active = false; start = end = preview = dragging = null; restoreControls(); publish(); };

  // ── Dragging an end of a FINISHED measurement ──────────────────────────────
  // The position comes from the pointer event itself, not from the chart's
  // crosshair: cancelling the pointerdown (which is what stops the chart
  // panning) also stops the browser sending the compatibility mouse events the
  // crosshair is driven by, so crosshair moves would go silent mid-drag.
  const paneAt = event => {
    const rect = element.getBoundingClientRect();
    const leftScale = chart.priceScale?.('left')?.width?.() || 0;
    return { x: event.clientX - rect.left - leftScale, y: event.clientY - rect.top };
  };
  const pointFromPane = ({ x, y }) => {
    if (x < 0 || x >= timeScale.width() || y < 0 || y >= element.clientHeight - timeScale.height()) return null;
    const time = timeScale.coordinateToTime(x);
    const price = series.coordinateToPrice(y);
    return time != null && Number.isFinite(price) ? { time, logical: timeScale.coordinateToLogical(x), price } : null;
  };
  const editable = () => !active && start && end;
  const onPointerDown = event => {
    if (!editable()) return;
    const { x, y } = paneAt(event);
    const which = nearestEndpoint(project(start), project(end), x, y);
    if (!which) return;                    // anywhere else, the chart pans as usual
    event.preventDefault(); event.stopPropagation();
    element.setPointerCapture?.(event.pointerId);
    dragging = which;
    const options = chart.options();
    savedControls = JSON.parse(JSON.stringify({ handleScroll: options.handleScroll, handleScale: options.handleScale }));
    chart.applyOptions({ handleScroll: false, handleScale: false });
    element.style.cursor = 'grabbing';
    publish();
  };
  const onPointerMove = event => {
    if (dragging) {
      const point = pointFromPane(paneAt(event));
      // Outside the price pane the end keeps its last good position.
      if (point) ({ start, end } = moveEndpoint({ active, start, end }, dragging, point));
      publish();
      return;
    }
    if (editable()) {
      const { x, y } = paneAt(event);
      element.style.cursor = nearestEndpoint(project(start), project(end), x, y) ? 'grab' : previousCursor;
    }
    schedule();
  };
  const endDrag = event => {
    if (!dragging) return;
    element.releasePointerCapture?.(event?.pointerId);
    dragging = null;
    restoreControls();
    publish();
  };
  const onPointerUp = event => { endDrag(event); schedule(); };
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
  // pointerdown listens in the CAPTURE phase so a grab on an end is claimed
  // before the chart's own handlers can start a pan.
  element.addEventListener('pointerdown', onPointerDown, { capture: true });
  element.addEventListener('pointermove', onPointerMove, { passive: true });
  element.addEventListener('pointerup', onPointerUp, { passive: true });
  element.addEventListener('pointercancel', endDrag, { passive: true });
  element.addEventListener('wheel', schedule, { passive: true });
  win.addEventListener('keydown', onKey);
  publish();
  return {
    isActive: () => active,
    clear,
    toggle() {
      if (active) { clear(); return; }
      start = end = preview = dragging = null;
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
      element.removeEventListener('pointerdown', onPointerDown, { capture: true });
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', endDrag);
      element.removeEventListener('wheel', schedule);
      win.removeEventListener('keydown', onKey);
    },
  };
}
