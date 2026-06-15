// Bar-walking backtest engine. O(n) per stock: all indicator series come
// precomputed from buildSeries; this file only does array lookups and fills.
//
// Execution model:
//  - Entry/signal-exit fills happen at the NEXT bar's open (entry conditions
//    need the close + full-day volume, which only exist after the session).
//  - Stops/targets fill intrabar on daily OHLC, pessimistically: a gap through
//    the stop fills at the open; if stop and target both touch in one bar the
//    stop wins (daily bars hide the path — assume the worst).
//  - Costs: flat costPct round-trip, half applied to each leg's fill price.
//  - One position at a time; qty = floor(capitalPerTrade / entryFill).
const { buildSeries } = require('./indicators');
const { STRATEGIES } = require('./strategies');
const { computeMetrics } = require('./metrics');

function runBacktest({ candles, strategyId, params = {}, costPct = 0.25, capitalPerTrade = 100000 }) {
  const strategy = STRATEGIES[strategyId];
  if (!strategy) throw new Error(`Unknown strategy "${strategyId}"`);
  const p = { ...strategy.defaults, ...params };
  const S = buildSeries(candles, { atrPeriod: p.atrPeriod, atrMult: p.atrMult });
  const n = candles.length;
  const warmup = strategy.warmupBars(p);
  if (n <= warmup + 2) throw new Error(`Insufficient history: ${n} bars, need > ${warmup + 2}`);

  const entryCostMult = 1 + costPct / 200; // half the round-trip per leg
  const exitCostMult = 1 - costPct / 200;
  const day = (d) => String(d).slice(0, 10);

  const trades = [];
  let pos = null;            // { entryIdx, entryDate, entryPrice, qty, stop, initialStop, target, hi, lo }
  let pendingEntry = false;  // signal fired at prior close → fill at this open
  let pendingExit = false;   // signal exit at prior close → fill at this open
  let realized = 0;
  const equityCurve = [];
  const buyHoldCurve = [];

  // Buy-and-hold baseline: same capital, bought at the first evaluable bar's open.
  const bhEntry = S.opens[warmup];
  const bhQty = capitalPerTrade / bhEntry;

  const closeTrade = (i, fillRaw, reason) => {
    const exitPrice = fillRaw * exitCostMult;
    const pnl = (exitPrice - pos.entryPrice) * pos.qty;
    const risk = pos.entryPrice - pos.initialStop;
    trades.push({
      entryDate: day(pos.entryDate),
      entryPrice: +pos.entryPrice.toFixed(2),
      exitDate: day(S.dates[i]),
      exitPrice: +exitPrice.toFixed(2),
      exitReason: reason,
      qty: pos.qty,
      holdDays: Math.max(1, Math.round((new Date(S.dates[i]) - new Date(pos.entryDate)) / 86400000)),
      initialStop: +pos.initialStop.toFixed(2),
      rMultiple: risk > 0 ? +((exitPrice - pos.entryPrice) / risk).toFixed(2) : null,
      pnl: +pnl.toFixed(2),
      pnlPct: +(((exitPrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2),
      maxFavorablePct: +(((pos.hi - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2),
      maxAdversePct: +(((pos.lo - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2),
    });
    realized += pnl;
    pos = null;
  };

  let barsInMarket = 0;

  for (let i = warmup; i < n; i++) {
    const open = S.opens[i], high = S.highs[i], low = S.lows[i], close = S.closes[i];

    // 1. Fill pending signal exit at this open.
    if (pos && pendingExit) {
      closeTrade(i, open, 'TREND_FLIP');
      pendingExit = false;
    }

    // 2. Fill pending entry at this open.
    if (!pos && pendingEntry) {
      const fill = open * entryCostMult;
      const qty = Math.floor(capitalPerTrade / fill);
      if (qty > 0) {
        const initialStop = strategy.initialStop(i - 1, S, p, fill);
        pos = {
          entryIdx: i,
          entryDate: S.dates[i],
          entryPrice: fill,
          qty,
          stop: initialStop,
          initialStop,
          target: p.targetR > 0 ? fill + p.targetR * (fill - initialStop) : null,
          hi: fill, lo: fill,
        };
      }
      pendingEntry = false;
    }

    // 3. Intrabar stop/target checks (skip the entry bar's own open-fill bar
    //    for the stop-at-open case only when entry just filled at this open —
    //    a same-bar gap below the stop is still honored via the low check).
    if (pos && i > pos.entryIdx) {
      if (open <= pos.stop) { closeTrade(i, open, 'STOP'); }                 // gapped through
      else if (low <= pos.stop) { closeTrade(i, pos.stop, 'STOP'); }
      else if (pos.target != null && high >= pos.target) { closeTrade(i, pos.target, 'TARGET'); }
    } else if (pos && i === pos.entryIdx) {
      if (low <= pos.stop) { closeTrade(i, Math.min(pos.stop, open), 'STOP'); }
      else if (pos.target != null && high >= pos.target) { closeTrade(i, pos.target, 'TARGET'); }
    }

    // 4. Close-of-bar rule evaluation.
    if (pos) {
      pos.hi = Math.max(pos.hi, high);
      pos.lo = Math.min(pos.lo, low);
      const { exitSignal, stop } = strategy.exitRule(pos, i, S, p);
      pos.stop = stop;
      if (exitSignal) pendingExit = true;
      barsInMarket++;
    } else if (!pendingEntry && i < n - 1) {
      if (strategy.entryRule(i, S, p)) pendingEntry = true;
    }

    // 5. Mark to market.
    const equity = capitalPerTrade + realized + (pos ? (close - pos.entryPrice) * pos.qty : 0);
    equityCurve.push({ date: day(S.dates[i]), equity: +equity.toFixed(2) });
    buyHoldCurve.push({ date: day(S.dates[i]), equity: +(bhQty * close).toFixed(2) });
  }

  // Annotate drawdown on the equity curve (single pass).
  let peak = -Infinity;
  for (const pt of equityCurve) {
    peak = Math.max(peak, pt.equity);
    pt.drawdownPct = peak > 0 ? +(((pt.equity - peak) / peak) * 100).toFixed(2) : 0;
  }

  // Open position at data end — reported separately, excluded from closed stats.
  let openPosition = null;
  if (pos) {
    const lastClose = S.closes[n - 1];
    const risk = pos.entryPrice - pos.initialStop;
    openPosition = {
      entryDate: day(pos.entryDate),
      entryPrice: +pos.entryPrice.toFixed(2),
      qty: pos.qty,
      stop: +pos.stop.toFixed(2),
      initialStop: +pos.initialStop.toFixed(2),
      lastClose: +lastClose.toFixed(2),
      unrealizedPnl: +(((lastClose - pos.entryPrice) * pos.qty)).toFixed(2),
      unrealizedPct: +(((lastClose - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2),
      rMultiple: risk > 0 ? +((lastClose - pos.entryPrice) / risk).toFixed(2) : null,
    };
  }

  const metrics = computeMetrics(trades, equityCurve, buyHoldCurve, { barsInMarket, totalBars: n - warmup });

  return {
    strategyId,
    params: p,
    costPct,
    capitalPerTrade,
    bars: n,
    evaluatedBars: n - warmup,
    fromDate: day(S.dates[warmup]),
    toDate: day(S.dates[n - 1]),
    trades,
    openPosition,
    equityCurve,
    buyHoldCurve,
    metrics,
  };
}

module.exports = { runBacktest };
