import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateHistoricalReturns,
  computeRsi14,
  computeSMA,
  rsiMultiplierFor,
  resampleToWeeklyHighs,
  findHiddenLeaders,
} from './sectorAnalytics.js';

// One daily bar per week, spaced 7 days apart from a fixed Monday, so each bar
// lands in its own Friday-keyed weekly bucket.
const WEEK0 = new Date('2026-01-05T00:00:00Z'); // a Monday
const weeklySeries = (highs) => highs.map((high, i) => {
  const d = new Date(WEEK0);
  d.setUTCDate(WEEK0.getUTCDate() + i * 7);
  return { date: d.toISOString(), high, close: high, low: high };
});

// stocks carry pre-resampled weeklyHighs, matching how the pages pass them.
const stock = (symbol, highs, rsVsSector) => ({
  symbol,
  rsVsSector,
  weeklyHighs: highs.map((high, i) => ({ weekKey: `w${i}`, high, close: high })),
});

// Prior 4 weeks peak at 120, recent 4 peak at 110 → sector Lower High.
const SECTOR_LOWER_HIGH = weeklySeries([100, 110, 120, 115, 105, 108, 110, 104]);
// Recent 4 peak at 140 → sector still making Higher Highs.
const SECTOR_HIGHER_HIGH = weeklySeries([100, 110, 120, 115, 125, 130, 140, 135]);

const HIGHER_HIGH = [10, 11, 12, 11, 13, 14, 15, 14]; // recent max 15 > prior 12
const LOWER_HIGH = [20, 22, 24, 23, 19, 18, 17, 16];  // recent max 19 < prior 24

describe('findHiddenLeaders', () => {
  test('returns null when sector history is too short to judge', () => {
    assert.equal(findHiddenLeaders(weeklySeries([1, 2, 3]), []), null);
    assert.equal(findHiddenLeaders(null, []), null);
  });

  test('is inactive when the sector is not making a Lower High', () => {
    const r = findHiddenLeaders(SECTOR_HIGHER_HIGH, [stock('AAA', HIGHER_HIGH, 5)]);
    assert.equal(r.active, false);
    assert.deepEqual(r.leaders, []);
  });

  test('includes a Higher-High stock that is outperforming the sector', () => {
    const r = findHiddenLeaders(SECTOR_LOWER_HIGH, [stock('AAA', HIGHER_HIGH, 4.2)]);
    assert.equal(r.active, true);
    assert.deepEqual(r.leaders.map(s => s.symbol), ['AAA']);
  });

  // Regression: MAHABANK held a stale 4-week-old weekly high while down ~10%
  // on the month and underperforming its sector by 9.4%, and was still being
  // labelled a Hidden Leader.
  test('excludes a Higher-High stock with negative relative strength', () => {
    const r = findHiddenLeaders(SECTOR_LOWER_HIGH, [stock('STALE', HIGHER_HIGH, -9.4)]);
    assert.equal(r.active, true);
    assert.deepEqual(r.leaders, []);
  });

  // The legitimate case the gate must preserve: falling stock, faster-falling
  // sector (observed live on SMH — AMD -1.66% 1M but +9.85% vs sector).
  test('keeps a stock that is down but falling less than its sector', () => {
    const r = findHiddenLeaders(SECTOR_LOWER_HIGH, [stock('AMD', HIGHER_HIGH, 9.85)]);
    assert.deepEqual(r.leaders.map(s => s.symbol), ['AMD']);
  });

  test('excludes stocks that are not making Higher Highs, however strong', () => {
    const r = findHiddenLeaders(SECTOR_LOWER_HIGH, [stock('WEAK', LOWER_HIGH, 12)]);
    assert.deepEqual(r.leaders, []);
  });

  test('skips stocks with insufficient or missing weekly history', () => {
    const thin = { symbol: 'THIN', rsVsSector: 5, weeklyHighs: [{ high: 1 }] };
    const none = { symbol: 'NONE', rsVsSector: 5 };
    const r = findHiddenLeaders(SECTOR_LOWER_HIGH, [thin, none]);
    assert.deepEqual(r.leaders, []);
  });

  test('treats a null rsVsSector as not qualifying', () => {
    const r = findHiddenLeaders(SECTOR_LOWER_HIGH, [stock('UNK', HIGHER_HIGH, null)]);
    assert.deepEqual(r.leaders, []);
  });

  test('tolerates an empty or missing stock list', () => {
    assert.deepEqual(findHiddenLeaders(SECTOR_LOWER_HIGH, []).leaders, []);
    assert.deepEqual(findHiddenLeaders(SECTOR_LOWER_HIGH, null).leaders, []);
  });
});

describe('resampleToWeeklyHighs', () => {
  test('returns an empty array for empty or missing input', () => {
    assert.deepEqual(resampleToWeeklyHighs([]), []);
    assert.deepEqual(resampleToWeeklyHighs(null), []);
  });

  test('collapses a week of dailies to that week\'s highest high', () => {
    const mon = new Date('2026-01-05T00:00:00Z');
    const days = [0, 1, 2].map(i => {
      const d = new Date(mon); d.setUTCDate(mon.getUTCDate() + i);
      return { date: d.toISOString(), high: 10 + i, close: 10 + i };
    });
    const weeks = resampleToWeeklyHighs(days);
    assert.equal(weeks.length, 1);
    assert.equal(weeks[0].high, 12);
    assert.equal(weeks[0].close, 12); // last close of the week
  });

  test('falls back to close when a bar carries no high', () => {
    const weeks = resampleToWeeklyHighs([{ date: WEEK0.toISOString(), close: 42 }]);
    assert.equal(weeks[0].high, 42);
  });

  test('emits weeks in chronological order', () => {
    const weeks = resampleToWeeklyHighs(weeklySeries([5, 6, 7]));
    assert.equal(weeks.length, 3);
    assert.deepEqual(weeks.map(w => w.high), [5, 6, 7]);
  });
});

describe('computeRsi14', () => {
  test('returns null below the 15-bar seed requirement', () => {
    assert.equal(computeRsi14(null), null);
    assert.equal(computeRsi14(Array.from({ length: 14 }, (_, i) => ({ close: i }))), null);
  });

  // With no down-closes the RS ratio would be infinite; the implementation
  // caps it at 100 instead, so a pure advance reads 99.0 rather than 100.
  test('caps an unbroken advance at 99 rather than dividing by zero', () => {
    const rising = Array.from({ length: 20 }, (_, i) => ({ close: 100 + i }));
    assert.equal(computeRsi14(rising), 99);
  });

  test('lands below 50 for a sustained decline', () => {
    const falling = Array.from({ length: 30 }, (_, i) => ({ close: 200 - i * 2 }));
    const rsi = computeRsi14(falling);
    assert.ok(rsi < 50, `expected < 50, got ${rsi}`);
  });

  test('is bounded to 0..100', () => {
    const choppy = Array.from({ length: 40 }, (_, i) => ({ close: 100 + (i % 5) * 3 - (i % 3) }));
    const rsi = computeRsi14(choppy);
    assert.ok(rsi >= 0 && rsi <= 100, `out of range: ${rsi}`);
  });
});

describe('computeSMA', () => {
  test('returns null when there are fewer closes than the period', () => {
    assert.equal(computeSMA([1, 2], 5), null);
  });

  test('averages exactly the last `period` closes', () => {
    assert.equal(computeSMA([100, 1, 2, 3, 4], 4), 2.5); // ignores the leading 100
  });

  test('handles period equal to the series length', () => {
    assert.equal(computeSMA([2, 4, 6], 3), 4);
  });
});

describe('rsiMultiplierFor', () => {
  test('is neutral for a null or mid-range reading', () => {
    assert.equal(rsiMultiplierFor(null), 1.0);
    assert.equal(rsiMultiplierFor(50), 1.0);
  });

  test('discounts overbought and rewards oversold', () => {
    assert.equal(rsiMultiplierFor(85), 0.85);
    assert.equal(rsiMultiplierFor(75), 0.92);
    assert.equal(rsiMultiplierFor(25), 1.08);
    assert.equal(rsiMultiplierFor(15), 1.15);
  });

  test('applies the documented thresholds inclusively', () => {
    assert.equal(rsiMultiplierFor(80), 0.85);
    assert.equal(rsiMultiplierFor(70), 0.92);
    assert.equal(rsiMultiplierFor(30), 1.08);
    assert.equal(rsiMultiplierFor(20), 1.15);
    // just inside the neutral band
    assert.equal(rsiMultiplierFor(69.9), 1.0);
    assert.equal(rsiMultiplierFor(30.1), 1.0);
  });
});

describe('calculateHistoricalReturns', () => {
  // A long daily series ending today, so every lookback window resolves.
  const today = new Date();
  const daily = Array.from({ length: 900 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - (899 - i));
    return { date: d.toISOString(), close: 100, high: 100 };
  });

  test('reports zero across the board for a flat series', () => {
    const r = calculateHistoricalReturns(daily, 100);
    for (const k of ['1W', '1M', '3M', '6M', '1Y', '2Y', '3Y']) {
      assert.equal(r[k], 0, `${k} should be flat`);
    }
  });

  test('reports a positive return when price is above history', () => {
    const r = calculateHistoricalReturns(daily, 110);
    assert.ok(Math.abs(r['1M'] - 10) < 1e-9, `expected +10%, got ${r['1M']}`);
  });

  test('returns 0 rather than dividing by a zero or empty history', () => {
    assert.equal(calculateHistoricalReturns([], 100)['1M'], 0);
    const zeroed = daily.map(c => ({ ...c, close: 0 }));
    assert.equal(calculateHistoricalReturns(zeroed, 100)['1M'], 0);
  });

  test('accepts an explicit timezone without changing a flat result', () => {
    const r = calculateHistoricalReturns(daily, 100, 'America/New_York');
    assert.equal(r['1M'], 0);
  });
});
