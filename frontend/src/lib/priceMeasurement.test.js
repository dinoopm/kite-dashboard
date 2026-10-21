import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPriceMeasurement, priceMeasurement, measurementDate } from './priceMeasurement.js';
const point = (price, day, logical = day) => ({ price, time: { year: 2026, month: 10, day }, logical });
test('percentage is measured from the first clicked price, including reverse and same-point selections', () => {
  assert.deepEqual(priceMeasurement(point(100, 1), point(125, 11)), { change: 25, percent: 25, bars: 10, days: 10 });
  assert.deepEqual(priceMeasurement(point(125, 11), point(100, 1)), { change: -25, percent: -20, bars: 10, days: 10 });
  assert.equal(priceMeasurement(point(100, 1), point(100, 1)).percent, 0);
  assert.equal(priceMeasurement(point(0, 1), point(1, 2)), null);
  assert.equal(priceMeasurement(point(NaN, 1), point(1, 2)), null);
  assert.equal(priceMeasurement(point(100, 1), point(Infinity, 2)), null);
});
test('calendar dates remain stable across DST and support chart time formats', () => {
  assert.equal(priceMeasurement({ price: 10, time: '2026-10-31' }, { price: 11, time: '2026-11-02' }).days, 2);
  assert.equal(measurementDate({ year: 2026, month: 10, day: 1 }), '1 Oct 2026');
  assert.equal(measurementDate(Date.UTC(2026, 9, 1) / 1000), '1 Oct 2026');
});
function setup() {
  const handlers = {}, events = new Map(), frames = new Map();
  let latest, pan = 0, zoom = 1, id = 0;
  const win = { addEventListener: (k, f) => events.set(k, f), removeEventListener: k => events.delete(k), requestAnimationFrame: f => { frames.set(++id, f); return id; }, cancelAnimationFrame: n => frames.delete(n) };
  const el = { ownerDocument: { defaultView: win }, style: { cursor: 'default' }, clientHeight: 480, addEventListener: (k, f) => events.set(k, f), removeEventListener: k => events.delete(k) };
  const ts = { width: () => 800, height: () => 30, timeToCoordinate: t => (t.day - 1) * 20 + pan, subscribeVisibleLogicalRangeChange: f => { handlers.range = f; }, unsubscribeVisibleLogicalRangeChange: () => delete handlers.range, subscribeSizeChange: f => { handlers.size = f; }, unsubscribeSizeChange: () => delete handlers.size };
  const applied = [];
  const options = { handleScroll: { pressedMouseMove: true, mouseWheel: false }, handleScale: { mouseWheel: true, axisPressedMouseMove: { time: true, price: true } } };
  const chart = { timeScale: () => ts, options: () => options, applyOptions: x => applied.push(x), subscribeClick: f => { handlers.click = f; }, unsubscribeClick: () => delete handlers.click, subscribeCrosshairMove: f => { handlers.move = f; }, unsubscribeCrosshairMove: () => delete handlers.move };
  const series = { coordinateToPrice: y => (450 - y) / zoom, priceToCoordinate: price => 450 - price * zoom };
  const controller = createPriceMeasurement(chart, series, el, state => { latest = state; });
  const click = (price, day) => handlers.click({ time: { year: 2026, month: 10, day }, logical: day, point: { x: day * 20, y: 450 - price * zoom } });
  const move = (price, day) => handlers.move({ time: { year: 2026, month: 10, day }, logical: day, point: { x: day * 20, y: 450 - price * zoom } });
  const flush = () => { for (const f of frames.values()) f(); frames.clear(); };
  return { controller, handlers, events, applied, click, move, flush, latest: () => latest, el, options, frames, transform(x, scale) { pan = x; zoom = scale; handlers.range(); flush(); } };
}
test('two clicks preview then freeze the result and restore the original chart interaction settings', () => {
  const m = setup();
  m.click(100, 1); assert.equal(m.latest().start, null);
  m.controller.toggle(); assert.equal(m.latest().active, true);
  assert.deepEqual(m.applied.at(-1), { handleScroll: false, handleScale: false });
  m.click(100, 1); m.move(120, 4);
  assert.equal(m.latest().result.percent, 20); assert.equal(m.latest().end, null);
  m.click(125, 5); m.move(150, 8);
  assert.equal(m.latest().result.percent, 25); assert.equal(m.latest().active, false);
  assert.deepEqual(m.applied.at(-1), m.options); assert.equal(m.el.style.cursor, 'default');
  m.controller.dispose();
});
test('completed anchors follow horizontal pan, price-scale zoom and resize without changing measured values', () => {
  const m = setup(); m.controller.toggle(); m.click(100, 1); m.click(125, 5);
  m.transform(50, 2);
  assert.deepEqual(m.latest().geometry.from, { x: 50, y: 250 });
  assert.deepEqual(m.latest().geometry.to, { x: 130, y: 200 });
  assert.equal(m.latest().result.percent, 25);
  m.el.clientHeight = 600; m.handlers.size(); m.flush();
  assert.equal(m.latest().geometry.height, 570);
  m.controller.dispose();
});
test('axes and missing times are ignored, and clear/Escape and disposal clean up selection and event listeners', () => {
  const m = setup(); m.controller.toggle();
  m.handlers.click({ time: point(1, 1).time, point: { x: 900, y: 100 } });
  m.handlers.click({ time: point(1, 1).time, point: { x: 10, y: 470 } });
  m.handlers.click({ point: { x: 10, y: 100 } });
  assert.equal(m.latest().start, null);
  m.click(100, 1); m.events.get('keydown')({ key: 'Escape', preventDefault() {} });
  assert.equal(m.latest().start, null); assert.equal(m.latest().active, false);
  m.controller.toggle(); m.click(100, 1); m.controller.clear();
  assert.equal(m.latest().geometry, null);
  m.controller.toggle(); m.click(100, 1); m.handlers.range();
  m.controller.dispose();
  assert.equal(m.events.size, 0); assert.equal(Object.keys(m.handlers).length, 0); assert.equal(m.frames.size, 0);
  assert.deepEqual(m.applied.at(-1), m.options);
});
