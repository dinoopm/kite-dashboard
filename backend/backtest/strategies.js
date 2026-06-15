// Strategy registry for the backtester. Each strategy is a set of PURE
// per-bar rules evaluated against the precomputed series bundle `S` from
// indicators.buildSeries — never call computeStockAlert in a loop (O(n²)).
//
// Interface:
//   defaults      — param values merged under user params
//   paramsSchema  — drives the frontend form (type: 'number' | 'bool')
//   warmupBars(p) — first index the engine may evaluate rules at
//   entryRule(i, S, p)            — true → buy at bar i+1 open
//   initialStop(i, S, p, fill)    — stop set at fill time (signal bar index i)
//   exitRule(pos, i, S, p)        — evaluated at bar i close while held;
//        returns { exitSignal: 'TREND_FLIP'|null, stop } where stop is the
//        (possibly ratcheted) stop to carry into the next bar.
const { rollingMax, rollingMin } = require('./indicators');

const STRATEGIES = {
  'supertrend-swing': {
    id: 'supertrend-swing',
    label: 'SuperTrend Swing',
    description: 'Mirrors the live STRONG BUY gates: SuperTrend(10,3) BULL + ADX ≥ 25 + close > EMA200 + RSI 60–70 momentum band + volume ≥ 1.2× 20d avg. Exits on SuperTrend flip or trailing SuperTrend-line stop. (The live rule\'s confidence ≥ 70 gate is intentionally not modeled in v1 — only the five mechanical filters.)',
    defaults: {
      atrPeriod: 10, atrMult: 3, adxMin: 25, rsiLow: 60, rsiHigh: 70,
      useEma200Filter: true, volMult: 1.2, targetR: 0,
    },
    paramsSchema: [
      { key: 'atrPeriod', label: 'ATR period', type: 'number', min: 5, max: 21, step: 1 },
      { key: 'atrMult', label: 'SuperTrend multiplier', type: 'number', min: 1.5, max: 5, step: 0.5 },
      { key: 'adxMin', label: 'ADX threshold', type: 'number', min: 15, max: 40, step: 1 },
      { key: 'rsiLow', label: 'RSI band low', type: 'number', min: 40, max: 65, step: 1 },
      { key: 'rsiHigh', label: 'RSI band high', type: 'number', min: 65, max: 85, step: 1 },
      { key: 'volMult', label: 'Volume × 20d avg', type: 'number', min: 1, max: 3, step: 0.1 },
      { key: 'useEma200Filter', label: 'Require close > EMA200', type: 'bool' },
      { key: 'targetR', label: 'Target (R multiple, 0 = off)', type: 'number', min: 0, max: 5, step: 0.5 },
    ],
    warmupBars: () => 210, // EMA200 + SuperTrend seed
    entryRule(i, S, p) {
      return S.supertrend[i]?.direction === 'BULL'
        && S.adx14[i] != null && S.adx14[i] >= p.adxMin
        && (!p.useEma200Filter || (S.ema200[i] != null && S.closes[i] > S.ema200[i]))
        && S.rsi14[i] != null && S.rsi14[i] >= p.rsiLow && S.rsi14[i] <= p.rsiHigh
        && S.vol20avg[i] > 0 && S.volumes[i] >= p.volMult * S.vol20avg[i];
    },
    // Stop at entry = the SuperTrend line on the signal bar (the line sits
    // below price in a BULL trend — same dynamic SL the live tradePlan uses).
    initialStop(i, S, p, fill) {
      const st = S.supertrend[i]?.value;
      return (st != null && st < fill) ? st : fill * 0.95; // degenerate fallback
    },
    exitRule(pos, i, S) {
      // Trailing stop = PREVIOUS bar's SuperTrend line (today's line is drawn
      // from today's bar → using it intrabar would be lookahead). Ratchets up only.
      const prevSt = S.supertrend[i - 1];
      const stop = (prevSt?.direction === 'BULL' && prevSt.value > pos.stop) ? prevSt.value : pos.stop;
      if (S.supertrend[i]?.direction === 'BEAR') return { exitSignal: 'TREND_FLIP', stop };
      return { exitSignal: null, stop };
    },
  },

  'breakout': {
    id: 'breakout',
    label: 'Donchian Breakout',
    description: 'Enter when the close clears the prior N-day high on ≥ volMult × 20d average volume. Fixed ATR stop; exit on a close below the prior M-day low (or stop/target).',
    defaults: { lookback: 55, exitLookback: 20, volMult: 1.5, slAtrMult: 2, targetR: 0 },
    paramsSchema: [
      { key: 'lookback', label: 'Entry lookback (days)', type: 'number', min: 20, max: 252, step: 1 },
      { key: 'exitLookback', label: 'Exit lookback (days)', type: 'number', min: 10, max: 50, step: 1 },
      { key: 'volMult', label: 'Volume × 20d avg', type: 'number', min: 1, max: 3, step: 0.1 },
      { key: 'slAtrMult', label: 'Stop (× ATR14)', type: 'number', min: 1, max: 4, step: 0.5 },
      { key: 'targetR', label: 'Target (R multiple, 0 = off)', type: 'number', min: 0, max: 5, step: 0.5 },
    ],
    warmupBars: (p) => Math.max(p.lookback, 30) + 1,
    entryRule(i, S, p) {
      const hh = rollingMax(S.highs, p.lookback, i);
      return hh != null && S.closes[i] > hh
        && S.vol20avg[i] > 0 && S.volumes[i] >= p.volMult * S.vol20avg[i];
    },
    initialStop(i, S, p, fill) {
      const atr = S.atr14[i];
      return atr != null ? fill - p.slAtrMult * atr : fill * 0.95;
    },
    exitRule(pos, i, S, p) {
      const ll = rollingMin(S.lows, p.exitLookback, i);
      if (ll != null && S.closes[i] < ll) return { exitSignal: 'TREND_FLIP', stop: pos.stop };
      return { exitSignal: null, stop: pos.stop }; // fixed stop, never ratchets
    },
  },
};

// Public, JSON-safe view for GET /api/backtest/strategies.
function publicStrategyList() {
  return Object.values(STRATEGIES).map(({ id, label, description, defaults, paramsSchema }) =>
    ({ id, label, description, defaults, paramsSchema }));
}

module.exports = { STRATEGIES, publicStrategyList };
