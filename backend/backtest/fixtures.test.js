// Deterministic engine checks — run with: node backend/backtest/fixtures.test.js
// No test framework in backend/package.json, so plain assert + console output.
const assert = require('assert');
const { runBacktest } = require('./engine');
const { buildSeries } = require('./indicators');
const { STRATEGIES } = require('./strategies');

let passed = 0;
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { console.error(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1; }
};
const approx = (a, b, eps = 0.05) => {
  assert(Math.abs(a - b) <= eps, `expected ≈${b}, got ${a}`);
};

// Consecutive daily candles starting 2022-01-03.
function makeCandles(rows) {
  const start = new Date('2022-01-03T00:00:00Z');
  return rows.map((r, i) => {
    const d = new Date(start.getTime() + i * 86400000);
    return { date: d.toISOString().slice(0, 10) + 'T00:00:00+0530', ...r };
  });
}

const flatBar = (px = 100, vol = 1000) => ({ open: px, high: px + 1, low: px - 1, close: px, volume: vol });

// ─── Fixture 1: flat series → zero trades, buy-hold ≈ 0% ─────────
{
  console.log('Fixture 1: flat no-signal series');
  const candles = makeCandles(Array.from({ length: 400 }, () => flatBar()));
  for (const sid of Object.keys(STRATEGIES)) {
    const r = runBacktest({ candles, strategyId: sid });
    ok(`${sid}: zero trades`, () => assert.strictEqual(r.trades.length, 0));
    ok(`${sid}: no open position`, () => assert.strictEqual(r.openPosition, null));
    ok(`${sid}: equity flat at capital`, () => approx(r.equityCurve[r.equityCurve.length - 1].equity, 100000, 0.01));
    ok(`${sid}: buy-hold ≈ 0%`, () => approx(r.metrics.buyHold.totalReturnPct, 0, 0.01));
  }
}

// ─── Fixture 2: Donchian breakout — clean entry, gap-down stop ───
// 200 flat bars, then a high-volume close above the 55-bar high (signal),
// next-bar open fill, then a gap down through the stop (fills at open).
{
  console.log('Fixture 2: breakout entry + gap-through-stop exit');
  const rows = Array.from({ length: 200 }, () => flatBar());
  rows.push({ open: 100, high: 105.5, low: 100, close: 105, volume: 3000 });   // signal bar (idx 200)
  rows.push({ open: 106, high: 108, low: 105.5, close: 107, volume: 1500 });   // entry fill bar (idx 201)
  rows.push({ open: 107, high: 109, low: 106.5, close: 108, volume: 1200 });   // held
  rows.push({ open: 70, high: 72, low: 68, close: 71, volume: 4000 });         // gap through stop (idx 203)
  for (let i = 0; i < 20; i++) rows.push(flatBar(71));
  const candles = makeCandles(rows);

  const costPct = 0.25;
  const r = runBacktest({ candles, strategyId: 'breakout', params: { lookback: 55, exitLookback: 20, volMult: 1.5, slAtrMult: 2 }, costPct });
  const S = buildSeries(candles);
  const strat = STRATEGIES['breakout'];
  const p = { ...strat.defaults, lookback: 55, exitLookback: 20, volMult: 1.5, slAtrMult: 2 };

  ok('exactly one trade', () => assert.strictEqual(r.trades.length, 1));
  const t = r.trades[0];
  ok('signal fired on the engineered bar', () => assert(strat.entryRule(200, S, p)));
  ok('entry fills at signal+1 open', () => assert.strictEqual(t.entryDate, candles[201].date.slice(0, 10)));
  ok('entry price = open × (1 + cost/2)', () => approx(t.entryPrice, 106 * (1 + costPct / 200), 0.01));
  ok('initial stop = fill − 2×ATR14', () => approx(t.initialStop, t.entryPrice - 2 * S.atr14[200], 0.02));
  ok('gap-down fills at OPEN, not stop', () => {
    assert.strictEqual(t.exitReason, 'STOP');
    assert.strictEqual(t.exitDate, candles[203].date.slice(0, 10));
    approx(t.exitPrice, 70 * (1 - costPct / 200), 0.01);
  });
  ok('rMultiple consistent', () => approx(t.rMultiple, (t.exitPrice - t.entryPrice) / (t.entryPrice - t.initialStop), 0.02));
  ok('exitDate > entryDate', () => assert(new Date(t.exitDate) > new Date(t.entryDate)));
  ok('final equity = capital + Σpnl', () => {
    const sum = r.trades.reduce((s, x) => s + x.pnl, 0);
    approx(r.equityCurve[r.equityCurve.length - 1].equity, 100000 + sum, 0.01);
  });
  ok('no entry before warmup', () => {
    const warmupDate = candles[strat.warmupBars(p)].date.slice(0, 10);
    assert(t.entryDate >= warmupDate);
  });
  ok('buy-hold return = lastClose/warmupOpen − 1', () => {
    const w = strat.warmupBars(p);
    approx(r.metrics.buyHold.totalReturnPct, (candles[candles.length - 1].close / candles[w].open - 1) * 100, 0.05);
  });
}

// ─── Fixture 3: stop takes precedence over target on a wide bar ──
{
  console.log('Fixture 3: stop precedence over target');
  const rows = Array.from({ length: 200 }, () => flatBar());
  rows.push({ open: 100, high: 105.5, low: 100, close: 105, volume: 3000 });   // signal (idx 200)
  rows.push({ open: 106, high: 107, low: 105.5, close: 106.5, volume: 1500 }); // entry (idx 201)
  // Wide bar touching BOTH the ATR stop (below) and the 1R target (above).
  rows.push({ open: 106, high: 130, low: 80, close: 100, volume: 5000 });      // idx 202
  for (let i = 0; i < 5; i++) rows.push(flatBar());
  const candles = makeCandles(rows);
  const r = runBacktest({ candles, strategyId: 'breakout', params: { lookback: 55, volMult: 1.5, slAtrMult: 2, targetR: 1 } });
  ok('one trade, stopped not targeted', () => {
    assert.strictEqual(r.trades.length, 1);
    assert.strictEqual(r.trades[0].exitReason, 'STOP');
    assert.strictEqual(r.trades[0].exitDate, candles[202].date.slice(0, 10));
  });
}

// ─── Fixture 4: supertrend-swing — trend entry, trailing exit ────
// Oscillating warmup, then a persistent pullback-laced uptrend with elevated
// volume, then a hard reversal. Engine must enter (per its own entryRule),
// trail the SuperTrend stop upward, and exit on STOP or TREND_FLIP.
{
  console.log('Fixture 4: supertrend-swing trend ride');
  const rows = [];
  let px = 100;
  for (let i = 0; i < 220; i++) {
    const c = 100 + Math.sin(i / 5) * 1.5;
    rows.push({ open: px, high: Math.max(px, c) + 0.4, low: Math.min(px, c) - 0.4, close: c, volume: 1000 });
    px = c;
  }
  for (let i = 0; i < 90; i++) {
    const delta = (i % 3 === 2) ? -1.1 : +1.9;   // 2 up, 1 down → steady trend, RSI not pinned
    const c = px + delta;
    rows.push({ open: px, high: Math.max(px, c) + 0.4, low: Math.min(px, c) - 0.4, close: c, volume: 1600 });
    px = c;
  }
  for (let i = 0; i < 25; i++) {
    const c = px * 0.96;
    rows.push({ open: px * 0.985, high: px * 0.99, low: c - 1, close: c, volume: 2500 });
    px = c;
  }
  const candles = makeCandles(rows);
  // Widen the RSI band: this fixture validates fill mechanics + trailing stop,
  // not the live band calibration.
  const params = { rsiLow: 50, rsiHigh: 85, volMult: 1.2, adxMin: 20 };
  const r = runBacktest({ candles, strategyId: 'supertrend-swing', params });
  const S = buildSeries(candles, { atrPeriod: 10, atrMult: 3 });
  const strat = STRATEGIES['supertrend-swing'];
  const p = { ...strat.defaults, ...params };

  ok('at least one trade', () => assert(r.trades.length >= 1, `got ${r.trades.length}`));
  const t = r.trades[0];
  ok('entry aligns with a true signal at entryDate−1', () => {
    const entryIdx = candles.findIndex(c => c.date.slice(0, 10) === t.entryDate);
    assert(entryIdx > 0, 'entry bar not found');
    assert(strat.entryRule(entryIdx - 1, S, p), 'entryRule false on signal bar');
    approx(t.entryPrice, candles[entryIdx].open * (1 + 0.25 / 200), 0.02);
  });
  ok('exit is STOP or TREND_FLIP after reversal', () => assert(['STOP', 'TREND_FLIP'].includes(t.exitReason)));
  ok('trailing stop ratcheted above initial', () => {
    // Stop exit price after a long trend must be above the initial stop.
    if (t.exitReason === 'STOP') assert(t.exitPrice > t.initialStop, `exit ${t.exitPrice} <= initial stop ${t.initialStop}`);
  });
  ok('all trades: exitDate > entryDate', () => r.trades.forEach(x => assert(new Date(x.exitDate) > new Date(x.entryDate))));
  ok('final equity = capital + Σpnl (+ open MTM)', () => {
    const sum = r.trades.reduce((s, x) => s + x.pnl, 0) + (r.openPosition ? r.openPosition.unrealizedPnl : 0);
    approx(r.equityCurve[r.equityCurve.length - 1].equity, 100000 + sum, 0.5);
  });
}

// ─── Perf: 1000-bar run must be fast (O(n) sanity) ───────────────
{
  console.log('Perf check');
  const candles = makeCandles(Array.from({ length: 1000 }, (_, i) => flatBar(100 + Math.sin(i / 7) * 3)));
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 50; k++) runBacktest({ candles, strategyId: 'supertrend-swing' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(`50 × 1000-bar runs in ${ms.toFixed(0)}ms (< 2000ms)`, () => assert(ms < 2000));
}

console.log(process.exitCode ? '\nSOME CHECKS FAILED' : `\nAll ${passed} checks passed`);
