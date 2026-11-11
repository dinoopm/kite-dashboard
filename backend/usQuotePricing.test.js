const { test } = require('node:test');
const assert = require('node:assert/strict');
const { quoteFromSnapshot, extendedSession, yahooExtendedSession, newestExtended } = require('./usQuotePricing');
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

// The detail-page header keeps the regular close as its headline, so an
// out-of-hours print is returned beside it rather than folded into it.
const crwd = {
  dailyBar: { o: 231.89, h: 231.89, l: 213.22, c: 217.2, t: '2026-11-05T05:00:00Z' },
  prevDailyBar: { c: 241, t: '2026-11-04T05:00:00Z' },
  latestTrade: { p: 228.51, t: '2026-11-06T09:34:09.944569409Z' },
};
const crwdNow = { feed: 'delayed_sip', now: Date.parse('2026-11-06T09:49:00Z') };
test('pre-market is measured from the last regular close, not the day before it', () => {
  const x = extendedSession(crwd, crwdNow);
  assert.equal(x.session, 'pre-market');
  assert.equal(x.price, 228.51);
  assert.equal(x.base, 217.2);
  assert.ok(Math.abs(x.change - 11.31) < 1e-9);
  assert.ok(Math.abs(x.changePct - 5.2072) < 1e-3);
  assert.equal(x.asOf, crwd.latestTrade.t);
  assert.equal(x.feed, 'delayed_sip');
});
test('after-hours is measured from that same day\'s close, not the full-day change', () => {
  const x = extendedSession(snap, options);
  assert.equal(x.session, 'after-hours');
  assert.equal(x.base, 100);
  assert.equal(x.change, 3);
});
test('nothing is reported during the regular session', () => {
  const during = { ...snap, latestTrade: { p: 101, t: '2026-10-16T18:00:00Z' } };
  assert.equal(extendedSession(during, options), null);
});
test('no regular close means nothing to measure from', () => {
  assert.equal(extendedSession({ latestTrade: snap.latestTrade }, options), null);
});
test('a print outside 4 AM – 8 PM ET is not reported', () => {
  assert.equal(extendedSession({ ...snap, latestTrade: { p: 102, t: '2026-10-17T01:00:00Z' } }, options), null);
});

// The reported case: Yahoo's CRWD quote at 4:58 AM ET, compared with a page
// still showing the 4:36 print Alpaca's delayed feed had reached.
const yahooPre = {
  marketState: 'PRE', regularMarketPrice: 217.2, regularMarketTime: new Date('2026-11-05T21:00:01Z'),
  preMarketPrice: 225.95, preMarketTime: new Date('2026-11-06T09:58:02Z'),
};
const yahooNow = { now: Date.parse('2026-11-06T10:00:00Z') };
test('Yahoo pre-market is measured from its regular close', () => {
  const x = yahooExtendedSession(yahooPre, yahooNow);
  assert.equal(x.session, 'pre-market');
  assert.equal(x.price, 225.95);
  assert.equal(x.base, 217.2);
  assert.ok(Math.abs(x.change - 8.75) < 1e-9);
  assert.ok(Math.abs(x.changePct - 4.0285) < 1e-3);
  assert.equal(x.asOf, '2026-11-06T09:58:02.000Z');
  assert.equal(x.feed, 'yahoo');
});
test('Yahoo after-hours is reported as after-hours', () => {
  const post = { marketState: 'POST', regularMarketPrice: 100, regularMarketTime: new Date('2026-10-16T20:00:00Z'), postMarketPrice: 103, postMarketTime: new Date('2026-10-16T21:30:00Z') };
  const x = yahooExtendedSession(post, { now: Date.parse('2026-10-16T22:00:00Z') });
  assert.equal(x.session, 'after-hours');
  assert.equal(x.change, 3);
});
test('nothing is reported from Yahoo during the regular session', () => {
  assert.equal(yahooExtendedSession({ ...yahooPre, marketState: 'REGULAR' }, yahooNow), null);
});
// Yahoo keeps the morning's fields on the quote all day. After the close they
// describe a session that has already been overtaken by the regular one.
test('a print from before the last regular close is not reported', () => {
  const stale = { ...yahooPre, marketState: 'POST', regularMarketTime: new Date('2026-11-06T21:00:00Z') };
  assert.equal(yahooExtendedSession(stale, { now: Date.parse('2026-11-06T22:00:00Z') }), null);
});
test('the newer of last night and this morning wins', () => {
  const lastNight = { postMarketPrice: 219, postMarketTime: new Date('2026-11-06T00:59:00Z') };
  assert.equal(yahooExtendedSession({ ...yahooPre, ...lastNight }, yahooNow).session, 'pre-market');
  const noPreYet = { ...yahooPre, ...lastNight, preMarketPrice: undefined, preMarketTime: undefined };
  assert.equal(yahooExtendedSession(noPreYet, yahooNow).session, 'after-hours');
});
test('an unusable Yahoo quote reports nothing', () => {
  assert.equal(yahooExtendedSession(null, yahooNow), null);
  assert.equal(yahooExtendedSession({ ...yahooPre, regularMarketPrice: 0 }, yahooNow), null);
  assert.equal(yahooExtendedSession({ ...yahooPre, preMarketPrice: NaN }, yahooNow), null);
  assert.equal(yahooExtendedSession({ ...yahooPre, preMarketTime: new Date('2026-11-07T09:00:00Z') }, yahooNow), null);
});
test('the freshest out-of-hours print wins, and either source may be missing', () => {
  const alpaca = { price: 228.04, asOf: '2026-11-06T09:36:54.337078696Z' };
  const yahoo = { price: 225.95, asOf: '2026-11-06T09:58:02.000Z' };
  assert.equal(newestExtended(yahoo, alpaca), yahoo);
  assert.equal(newestExtended(alpaca, yahoo), yahoo);
  assert.equal(newestExtended(null, alpaca), alpaca);
  assert.equal(newestExtended(yahoo, null), yahoo);
  assert.equal(newestExtended(null, null), null);
});
// ZS at 5:02:59: one trade, stamped .000 by Yahoo and .813369196 by Alpaca,
// which would label a live price as "15-min delayed".
test('the same trade on both feeds counts as a tie, and the first source keeps it', () => {
  const yahoo = { price: 208, asOf: '2026-11-06T10:02:59.000Z', feed: 'yahoo' };
  const alpaca = { price: 208, asOf: '2026-11-06T10:02:59.813369196Z', feed: 'delayed_sip' };
  assert.equal(newestExtended(yahoo, alpaca), yahoo);
});
