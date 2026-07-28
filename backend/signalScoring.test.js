const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { forwardReturn, indexOfDate, scoreSignal, summarise } = require('./signalScoring');

// Deterministic series: close = base * (1 + step)^i, one bar per day.
const series = (base, step, n = 60, startDay = 1) =>
  Array.from({ length: n }, (_, i) => ({
    date: `2026-03-${String(startDay + i).padStart(2, '0')}`,
    close: +(base * Math.pow(1 + step, i)).toFixed(4),
  }));

const FLAT = series(100, 0);
const UP = series(100, 0.01);    // +1%/day
const DOWN = series(100, -0.01); // -1%/day

describe('forwardReturn', () => {
  test('measures the move over the horizon', () => {
    const r = forwardReturn(UP, 0, 10);
    // Fixture closes are rounded to 4dp, so allow a hair of drift.
    assert.ok(Math.abs(r - (Math.pow(1.01, 10) - 1) * 100) < 1e-3, `got ${r}`);
  });

  test('is zero for a flat series', () => {
    assert.equal(forwardReturn(FLAT, 5, 10), 0);
  });

  test('returns null rather than scoring an unresolved signal', () => {
    assert.equal(forwardReturn(UP, UP.length - 3, 10), null, 'horizon runs past the data');
    assert.equal(forwardReturn(UP, -1, 5), null);
    assert.equal(forwardReturn(UP, 999, 5), null);
    assert.equal(forwardReturn(null, 0, 5), null);
  });

  test('does not divide by a zero base price', () => {
    const zeroed = [{ date: '2026-03-01', close: 0 }, { date: '2026-03-02', close: 10 }];
    assert.equal(forwardReturn(zeroed, 0, 1), null);
  });
});

describe('indexOfDate', () => {
  test('finds a bar by plain date', () => {
    assert.equal(indexOfDate(UP, '2026-03-05'), 4);
  });
  test('matches an ISO timestamp against the date portion', () => {
    const iso = [{ date: '2026-03-05T00:00:00Z', close: 1 }];
    assert.equal(indexOfDate(iso, '2026-03-05'), 0);
  });
  test('returns -1 for a missing or absent date', () => {
    assert.equal(indexOfDate(UP, '2020-01-01'), -1);
    assert.equal(indexOfDate(UP, null), -1);
    assert.equal(indexOfDate(null, '2026-03-05'), -1);
  });
});

describe('scoreSignal', () => {
  const bySymbol = { WINNER: UP, LOSER: DOWN, FLAT };

  test('reports a perfect hit rate when every pick rose', () => {
    const s = scoreSignal(
      [{ symbol: 'WINNER', date: '2026-03-02' }, { symbol: 'WINNER', date: '2026-03-05' }],
      bySymbol, { horizons: [5] },
    );
    assert.equal(s['5d'].n, 2);
    assert.equal(s['5d'].hitRate, 1);
    assert.ok(s['5d'].medianPct > 0);
  });

  test('reports a zero hit rate when every pick fell', () => {
    const s = scoreSignal(
      [{ symbol: 'LOSER', date: '2026-03-02' }, { symbol: 'LOSER', date: '2026-03-05' }],
      bySymbol, { horizons: [5] },
    );
    assert.equal(s['5d'].hitRate, 0);
    assert.ok(s['5d'].medianPct < 0);
  });

  // The distinction the module exists to make.
  test('a signal that rises but lags the benchmark shows negative excess', () => {
    const slowUp = series(100, 0.002);      // +0.2%/day
    const fastBench = series(500, 0.01);    // +1%/day
    const s = scoreSignal(
      [{ symbol: 'SLOW', date: '2026-03-02' }],
      { SLOW: slowUp },
      { horizons: [10], benchmark: fastBench },
    );
    assert.equal(s['10d'].hitRate, 1, 'it did rise');
    assert.ok(s['10d'].medianPct > 0, 'raw return positive');
    assert.ok(s['10d'].medianExcessPct < 0, 'but it lagged the benchmark');
    assert.equal(s['10d'].hitRateExcess, 0);
  });

  test('median resists a single outlier that would carry the mean', () => {
    const moon = series(1, 0.5, 60);       // absurd winner
    const bySym = { LOSER: DOWN, MOON: moon };
    const emissions = [
      ...Array.from({ length: 5 }, () => ({ symbol: 'LOSER', date: '2026-03-02' })),
      { symbol: 'MOON', date: '2026-03-02' },
    ];
    const s = scoreSignal(emissions, bySym, { horizons: [5] });
    assert.ok(s['5d'].meanPct > 0, 'mean dragged positive by the outlier');
    assert.ok(s['5d'].medianPct < 0, 'median still reflects the typical trade');
  });

  test('counts unresolved emissions instead of scoring them', () => {
    const s = scoreSignal(
      [
        { symbol: 'WINNER', date: '2026-03-02' },
        { symbol: 'WINNER', date: '2026-04-99' },  // no such bar
        { symbol: 'UNKNOWN', date: '2026-03-02' }, // no series
        { symbol: 'WINNER', date: UP[UP.length - 1].date }, // horizon runs off the end
      ],
      bySymbol, { horizons: [5] },
    );
    assert.equal(s['5d'].n, 1);
    assert.equal(s['5d'].unresolved, 3);
  });

  test('excludes an emission whose benchmark window does not resolve', () => {
    const shortBench = series(100, 0.01, 3);
    const s = scoreSignal(
      [{ symbol: 'WINNER', date: '2026-03-02' }],
      bySymbol, { horizons: [5], benchmark: shortBench },
    );
    assert.equal(s['5d'].n, 1, 'raw return still scored');
    assert.equal(s['5d'].nExcess, 0, 'excess not fabricated');
    assert.equal(s['5d'].medianExcessPct, null);
  });

  test('handles no emissions without throwing', () => {
    const s = scoreSignal([], bySymbol, { horizons: [5] });
    assert.equal(s['5d'].n, 0);
    assert.equal(s['5d'].hitRate, null);
    assert.deepEqual(Object.keys(scoreSignal(null, bySymbol, { horizons: [5] })), ['5d']);
  });

  test('scores each requested horizon separately', () => {
    const s = scoreSignal([{ symbol: 'WINNER', date: '2026-03-02' }], bySymbol, { horizons: [5, 22] });
    assert.ok(s['22d'].medianPct > s['5d'].medianPct, 'longer horizon compounds further');
  });
});

describe('summarise', () => {
  test('refuses to call a result on a small sample', () => {
    assert.match(summarise({ n: 7, medianPct: 5, medianExcessPct: 3 }), /too few/);
  });

  test('says nothing when no signals resolved', () => {
    assert.match(summarise({ n: 0 }), /no resolved/);
    assert.match(summarise(null), /no resolved/);
  });

  test('reports direction against the benchmark once the sample is adequate', () => {
    assert.match(summarise({ n: 40, medianPct: 1, medianExcessPct: 2.5 }), /beat benchmark by 2\.50%/);
    assert.match(summarise({ n: 40, medianPct: 1, medianExcessPct: -1.25 }), /lagged benchmark by 1\.25%/);
  });

  test('falls back to raw return when there is no benchmark', () => {
    assert.match(summarise({ n: 40, medianPct: 1.5, medianExcessPct: null }), /no benchmark/);
  });
});
