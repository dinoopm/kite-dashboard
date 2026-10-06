const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rangeBreakoutFields } = require('./rangeBreakout');
const { computeScreenerRow, evaluateConditions, validateConditions } = require('./engine');
const day = i => new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10);
const bar = (i, close = 100, volume = 100) => ({ date: day(i), open: close, high: close + 1, low: close - 1, close, volume });
function setup(follow = 3) {
  const stock = Array.from({ length: 70 }, (_, i) => bar(i, 100 + Math.sin(i)));
  stock.push(bar(70, 104, 200));
  for (let i = 0; i < follow; i++) stock.push(bar(71 + i, 105));
  const benchmark = stock.map((_, i) => ({ date: day(i), close: 200 }));
  return { stock, benchmark };
}

test('fresh tight-range breakout holds three sessions with volume and relative strength', () => {
  const { stock, benchmark } = setup();
  const row = computeScreenerRow(stock, { benchmarkCandles: benchmark });
  assert.equal(row.rangeBreakoutStatus, 'CONFIRMED');
  assert.equal(row.rangeBreakoutAge, 3);
  assert.equal(row.rangeBreakoutDate, day(70));
  assert.equal(row.rangeBreakoutVol, 2);
  assert.equal(row.rangeBreakoutRs, 'YES');
  assert.ok(row.rangeBreakoutBasePct < 5);
  assert.ok(row.rangeBreakoutDistance > 0);
  const conditions = [
    { field: 'rangeBreakoutStatus', op: 'is', value: 'CONFIRMED' },
    { field: 'rangeBreakoutAge', op: 'lte', value: 10 },
    { field: 'rangeBreakoutBasePct', op: 'lte', value: 25 },
    { field: 'rangeBreakoutVol', op: 'gte', value: 1.5 },
    { field: 'rangeBreakoutRs', op: 'is', value: 'YES' },
  ];
  validateConditions(conditions);
  assert.equal(evaluateConditions(row, conditions), true);
});

test('confirmation is causal: zero through two later sessions stay pending', () => {
  for (let i = 0; i < 3; i++) {
    const { stock, benchmark } = setup(i);
    assert.equal(rangeBreakoutFields(stock, benchmark).rangeBreakoutStatus, 'PENDING');
  }
});

test('close below resistance fails; threshold equality still holds', () => {
  const { stock, benchmark } = setup();
  const level = rangeBreakoutFields(stock, benchmark).rangeBreakoutLevel;
  stock[71] = bar(71, level);
  assert.equal(rangeBreakoutFields(stock, benchmark).rangeBreakoutStatus, 'CONFIRMED');
  stock[71] = bar(71, level - 0.01);
  assert.equal(rangeBreakoutFields(stock, benchmark).rangeBreakoutStatus, 'FAILED');
});

test('failed poke does not suppress an immediate volume-backed reclaim', () => {
  const { stock } = setup(0);
  stock.push(bar(71, 99), bar(72, 106, 250), bar(73, 107), bar(74, 107), bar(75, 107));
  const benchmark = stock.map((_, i) => ({ date: day(i), close: 200 }));
  const row = rangeBreakoutFields(stock, benchmark);
  assert.equal(row.rangeBreakoutStatus, 'CONFIRMED');
  assert.equal(row.rangeBreakoutDate, day(72));
});

test('volume excludes the trigger and equality at 1.5× passes', () => {
  const { stock, benchmark } = setup();
  stock[70].volume = 150;
  assert.equal(rangeBreakoutFields(stock, benchmark).rangeBreakoutVol, 1.5);
  stock[70].volume = 149;
  assert.equal(rangeBreakoutFields(stock, benchmark).rangeBreakoutStatus, null);
  stock.forEach(bar => { bar.volume = 0; });
  assert.equal(rangeBreakoutFields(stock, benchmark).rangeBreakoutStatus, null);
});

test('no breakout on equality or a continuing rally without a fresh crossing', () => {
  const { stock, benchmark } = setup();
  stock[70].close = Math.max(...stock.slice(40, 70).map(bar => bar.high));
  stock[71].close = 100; stock[72].close = 100; stock[73].close = 100;
  assert.equal(rangeBreakoutFields(stock, benchmark).rangeBreakoutStatus, null);
});

test('missing, stale or misaligned benchmark data never becomes strength', () => {
  const { stock, benchmark } = setup();
  for (const data of [[], benchmark.slice(0, -1), benchmark.filter(bar => bar.date !== day(60))]) {
    const row = rangeBreakoutFields(stock, data);
    assert.equal(row.rangeBreakoutRs, null);
    assert.equal(row.relativeReturn20d, null);
  }
});

test('benchmark-relative fields use matched dates and distinguish a stronger rising index', () => {
  const { stock, benchmark } = setup();
  const stronger = benchmark.map((bar, i) => ({ ...bar, close: 200 * (1.01 ** i) }));
  const row = rangeBreakoutFields(stock, stronger);
  assert.equal(row.rangeBreakoutRs, 'NO');
  assert.ok(row.relativeReturn20d < 0);
  assert.deepEqual(rangeBreakoutFields(stock, benchmark), rangeBreakoutFields(stock, [...benchmark].reverse()));
});

test('insufficient history, missing high/low and invalid volume do not invent a setup', () => {
  assert.equal(rangeBreakoutFields([]).rangeBreakoutStatus, null);
  const { stock, benchmark } = setup();
  stock[60].high = null;
  assert.equal(rangeBreakoutFields(stock, benchmark).rangeBreakoutStatus, null);
  stock[60].high = 101; stock[60].volume = NaN;
  assert.equal(rangeBreakoutFields(stock, benchmark).rangeBreakoutStatus, null);
});

test('after confirmation a fall back below resistance has negative distance', () => {
  const { stock } = setup();
  stock.push(bar(74, 99));
  const benchmark = stock.map((_, i) => ({ date: day(i), close: 200 }));
  const row = rangeBreakoutFields(stock, benchmark);
  assert.equal(row.rangeBreakoutStatus, 'CONFIRMED');
  assert.ok(row.rangeBreakoutDistance < 0);
  assert.equal(evaluateConditions(row, [{ field: 'rangeBreakoutDistance', op: 'gte', value: 0 }]), false);
});
