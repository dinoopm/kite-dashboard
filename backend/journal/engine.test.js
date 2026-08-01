const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { buildRoundTrips, baseSymbol } = require('./engine');

const fill = (ts, side, qty, price) => ({ trade_ts: `${ts}T05:00:00+00:00`, side, qty, price });

describe('baseSymbol', () => {
  // The defect this exists for: SIGMAADV was bought on the EQ series and sold
  // after NSE moved it to trade-to-trade, so Kite reported SIGMAADV-BE. Keyed
  // on the raw tradingsymbol the buys and the sell never met — the position
  // stayed open forever and the sell fell into unmatchedSellQty, so the round
  // trip simply never appeared in the journal.
  test('strips an NSE series suffix', () => {
    assert.equal(baseSymbol('SIGMAADV-BE'), 'SIGMAADV');
    assert.equal(baseSymbol('FOO-SM'), 'FOO');
    assert.equal(baseSymbol('BAR-bz'), 'BAR');
  });

  test('leaves a genuinely hyphenated name alone', () => {
    assert.equal(baseSymbol('BAJAJ-AUTO'), 'BAJAJ-AUTO');
    assert.equal(baseSymbol('M&M-FIN'), 'M&M-FIN');
  });

  test('leaves a plain symbol untouched', () => {
    assert.equal(baseSymbol('RELIANCE'), 'RELIANCE');
  });

  test('survives null and undefined', () => {
    assert.equal(baseSymbol(null), '');
    assert.equal(baseSymbol(undefined), '');
  });
});

describe('buildRoundTrips', () => {
  test('closes a cycle when the position returns to flat', () => {
    const { trips, open, unmatchedSellQty } = buildRoundTrips([
      fill('2026-07-02', 'BUY', 20, 573),
      fill('2026-07-10', 'BUY', 20, 563),
      fill('2026-07-30', 'SELL', 40, 613),
    ]);
    assert.equal(trips.length, 1);
    assert.equal(open, null);
    assert.equal(unmatchedSellQty, 0);
    const t = trips[0];
    assert.equal(t.qty, 40);
    assert.equal(t.entryAvg, 568);   // (20*573 + 20*563) / 40
    assert.equal(t.exitAvg, 613);
    assert.equal(t.pnl, 1800);       // 40 * (613 - 568)
    assert.equal(t.entryDate, '2026-07-02');
    assert.equal(t.exitDate, '2026-07-30');
  });

  test('reports a still-open position rather than inventing an exit', () => {
    const { trips, open } = buildRoundTrips([
      fill('2026-07-02', 'BUY', 20, 573),
      fill('2026-07-30', 'SELL', 5, 613),
    ]);
    assert.equal(trips.length, 0);
    assert.equal(open.qty, 15);
    assert.equal(open.avgPrice, 573);
  });

  test('counts a sell with no matching buy instead of guessing an entry', () => {
    const { trips, unmatchedSellQty } = buildRoundTrips([
      fill('2026-07-30', 'SELL', 40, 613),
    ]);
    assert.equal(trips.length, 0);
    assert.equal(unmatchedSellQty, 40, 'bought before the backfill window');
  });

  test('matches lots first-in-first-out', () => {
    const { trips } = buildRoundTrips([
      fill('2026-07-01', 'BUY', 10, 100),
      fill('2026-07-02', 'BUY', 10, 200),
      fill('2026-07-03', 'SELL', 10, 150),
      fill('2026-07-04', 'SELL', 10, 150),
    ]);
    // Both lots close in one flat-to-flat cycle: avg entry 150, avg exit 150.
    assert.equal(trips.length, 1);
    assert.equal(trips[0].entryAvg, 150);
    assert.equal(trips[0].pnl, 0);
  });

  test('ignores fills with a non-positive quantity or price', () => {
    const { trips, unmatchedSellQty } = buildRoundTrips([
      fill('2026-07-01', 'BUY', 0, 100),
      fill('2026-07-02', 'BUY', 10, 0),
      fill('2026-07-03', 'SELL', 10, 150),
    ]);
    assert.equal(trips.length, 0);
    assert.equal(unmatchedSellQty, 10, 'the two bad buys never opened a position');
  });
});
