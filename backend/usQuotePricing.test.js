const { test } = require('node:test');
const assert = require('node:assert/strict');
const { quoteFromSnapshot } = require('./usQuotePricing');
const snap = {
  dailyBar: { c: 100, t: '2026-10-16T04:00:00Z' },
  prevDailyBar: { c: 98, t: '2026-10-15T04:00:00Z' },
  latestTrade: { p: 103, t: '2026-10-16T21:00:00Z' },
};
const options = { extended: true, feed: 'delayed_sip', now: Date.parse('2026-10-20T00:00:00Z') };
test('after-hours is folded into price and full-day change; legacy callers keep regular close', () => {
  const q = quoteFromSnapshot(snap, options);
  assert.equal(q.last_price, 103); assert.equal(q.net_change, 5);
  assert.equal(q.quote_session, 'after-hours'); assert.equal(q.feed, 'delayed_sip');
  assert.equal(q.quote_as_of, snap.latestTrade.t);
  assert.equal(quoteFromSnapshot(snap).last_price, 100);
});
test('Monday pre-market uses Friday close rather than Thursday close', () => {
  const q = quoteFromSnapshot({ ...snap, latestTrade: { p: 102, t: '2026-10-19T12:00:00Z' } }, options);
  assert.equal(q.last_price, 102); assert.equal(q.net_change, 2);
  assert.equal(q.ohlc.close, 100); assert.equal(q.quote_session, 'pre-market');
});
test('newer minute bar wins and stale prior-day trade cannot override current daily bar', () => {
  const q = quoteFromSnapshot({ ...snap, minuteBar: { c: 104, t: '2026-10-16T21:01:00Z' } }, options);
  assert.equal(q.last_price, 104);
  const stale = quoteFromSnapshot({ ...snap, dailyBar: { c: 105, t: '2026-10-19T04:00:00Z' } }, options);
  assert.equal(stale.last_price, 105); assert.equal(stale.quote_session, 'regular-close');
});
test('session times adjust for winter DST and reject invalid, future and overnight prints', () => {
  const winter = { dailyBar: { c: 100, t: '2026-12-01T05:00:00Z' }, prevDailyBar: { c: 99 } };
  assert.equal(quoteFromSnapshot({ ...winter, latestTrade: { p: 101, t: '2026-12-01T20:30:00Z' } }, { extended: true, now: Date.parse('2026-12-02T00:00:00Z') }).quote_session, 'regular');
  for (const trade of [{ p: NaN, t: snap.latestTrade.t }, { p: 0, t: snap.latestTrade.t }, { p: 102, t: 'invalid' }, { p: 102, t: '2026-10-21T21:00:00Z' }, { p: 102, t: '2026-10-17T01:00:00Z' }]) {
    assert.equal(quoteFromSnapshot({ ...snap, latestTrade: trade }, options).last_price, 100);
  }
});
test('missing baseline stays missing rather than fabricating a return', () => {
  const q = quoteFromSnapshot({ latestTrade: snap.latestTrade }, options);
  assert.equal(q.last_price, 103); assert.equal(q.net_change, null); assert.equal(q.ohlc.close, null);
});
