const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { computeScreenerRow } = require('./engine');

// Synthetic price shapes. high/low straddle the close by 1% so the range
// measures reflect the shape rather than intrabar noise.
const bar = (c, i) => ({ date: `d${String(i).padStart(3, '0')}`, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 100000 });
const series = (fn, n = 300) => Array.from({ length: n }, (_, i) => bar(fn(i), i));

describe('range52wPct', () => {
  test('is near zero for a stock that went nowhere', () => {
    const r = computeScreenerRow(series(() => 450));
    assert.ok(r.range52wPct < 3, `flat line should be tight, got ${r.range52wPct}`);
  });

  test('measures the band a range-bound stock traded in', () => {
    // Oscillates 410-490 — roughly a 20% band off the low.
    const r = computeScreenerRow(series(i => 450 + 40 * Math.sin(i / 9)));
    assert.ok(r.range52wPct > 15 && r.range52wPct < 30, `got ${r.range52wPct}`);
  });

  // The distinction the field exists for: distance-from-high cannot tell a
  // year of drift apart from a year of running, because both can sit 2% off
  // the high.
  test('separates a drifter from a runner that are both near their high', () => {
    const drifted = computeScreenerRow(series(i => 450 + 40 * Math.sin(i / 9)));
    const ran = computeScreenerRow(series(i => 300 * Math.pow(1.006, i)));
    assert.ok(ran.range52wPct > 10 * drifted.range52wPct,
      `runner ${ran.range52wPct} should dwarf drifter ${drifted.range52wPct}`);
  });

  // A row still comes back — the screener wants one per symbol — but the range
  // fields must be null rather than 0, or "no history" would screen as the
  // tightest range on the exchange and top every result.
  test('is null when there is not enough history to measure a range', () => {
    const r = computeScreenerRow(series(() => 450, 1));
    assert.equal(r.range52wPct, null);
    assert.equal(r.rangeCompression, null);
  });
});

describe('rangeCompression', () => {
  test('is about 1 when recent swings match the year', () => {
    const r = computeScreenerRow(series(i => 450 + 40 * Math.sin(i / 9)));
    assert.ok(Math.abs(r.rangeCompression - 1) < 0.15, `got ${r.rangeCompression}`);
  });

  test('falls when the last quarter is tighter than the year', () => {
    // Wide for nine months, then pinned into a narrow band.
    const r = computeScreenerRow(series(i => (i < 234 ? 450 + 90 * Math.sin(i / 9) : 450)));
    assert.ok(r.rangeCompression < 0.5, `expected coiling, got ${r.rangeCompression}`);
  });

  // Documented trap: a runaway trend also scores low here, for a completely
  // different reason. The field is only meaningful next to a narrow range.
  test('also reads low for a runaway trend, which is why it needs range52wPct', () => {
    const ran = computeScreenerRow(series(i => 300 * Math.pow(1.006, i)));
    assert.ok(ran.rangeCompression < 0.5, 'low compression on its own does not mean coiling');
    assert.ok(ran.range52wPct > 100, 'but the range width gives it away');
  });
});
