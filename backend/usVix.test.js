const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseVixHistory, vixSnapshot, createVixService } = require('./usVix');
const history = [{ date: '2026-10-22', close: 19.03 }, { date: '2026-10-23', close: 19.45 }];
const now = new Date('2026-10-27T10:00:00Z');
test('Cboe parser rejects missing values and impossible dates, sorts and deduplicates', () => {
  assert.deepEqual(parseVixHistory('DATE,OPEN,HIGH,LOW,CLOSE\n10/23/2026,1,2,3,19.45\n02/30/2026,1,2,3,99\n10/21/2026,1,2,3,\n10/22/2026,1,2,3,19\n10/22/2026,1,2,3,19.03'), history);
  assert.throws(() => parseVixHistory('<html>failure</html>'));
});
test('new quote appends a dated provisional point with change from previous close', () => {
  const data = vixSnapshot(history, { regularMarketPrice: 18.39, regularMarketTime: '2026-10-26T20:15:01Z', regularMarketPreviousClose: 19.45, exchangeDataDelayedBy: 15 }, now);
  assert.equal(data.series.length, 3); assert.equal(data.series.at(-1).date, '2026-10-26');
  assert.equal(data.delayMinutes, 15); assert.equal(data.kind, 'quote');
  assert.ok(Math.abs(data.change + 1.06) < 1e-8); assert.equal(history.length, 2);
});
test('same-day quote uses previous session, ignoring an in-progress daily point', () => {
  const data = vixSnapshot(history, { regularMarketPrice: 19.5, regularMarketTime: '2026-10-23T18:00:00Z' }, now);
  assert.equal(data.series.length, 2); assert.equal(data.previousClose, 19.03);
});
test('old, missing-time and future quotes cannot overwrite official history', () => {
  for (const time of ['2026-10-21T20:15:00Z', undefined, '2026-11-01T20:00:00Z']) {
    const data = vixSnapshot(history, { regularMarketPrice: 22, regularMarketTime: time }, now);
    assert.equal(data.current, 19.45); assert.equal(data.asOf, '2026-10-23'); assert.equal(data.kind, 'daily-close');
  }
});
test('feed failure preserves dated daily history; quote-only response does not invent history', async () => {
  const get = createVixService({ fetchHistory: async () => history, fetchQuote: async () => { throw Error('offline'); }, now: () => now });
  const data = await get(); assert.equal(data.kind, 'daily-close'); assert.equal(data.warnings.length, 1);
  const quoteOnly = vixSnapshot([], { regularMarketPrice: 20, regularMarketTime: '2026-10-26T20:15:00Z' }, now);
  assert.equal(quoteOnly.previousClose, null); assert.equal(quoteOnly.historyAsOf, null);
});
test('concurrent requests share work and cache quote separately from history', async () => {
  let historyCalls = 0, quoteCalls = 0, clock = +now;
  const get = createVixService({ fetchHistory: async () => { historyCalls++; return history; }, fetchQuote: async () => { quoteCalls++; return null; }, now: () => new Date(clock) });
  await Promise.all([get(), get()]); await get(); assert.equal(quoteCalls, 1); assert.equal(historyCalls, 1);
  clock += 61_000; await get(); assert.equal(quoteCalls, 2); assert.equal(historyCalls, 1);
});

test('missing quote baseline across a history gap leaves daily change unavailable', () => {
  const data = vixSnapshot(history, { regularMarketPrice: 20, regularMarketTime: '2026-10-27T08:00:00Z' }, now);
  assert.equal(data.previousClose, null); assert.equal(data.changePct, null);
});
