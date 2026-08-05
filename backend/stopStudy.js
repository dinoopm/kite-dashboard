// ─── Would a protective stop actually have helped? ───────────────────────────
//
// Phase 0 of the stop pipeline, and its gate. The journal says losers ran:
// NEWGEN -Rs 2,61,327 held 456 days against a 47-day median, average win +10.5%
// against average loss -10.6%, profit factor 0.37. A stop is the obvious
// response — but "obvious" is exactly the kind of claim this codebase exists to
// check before shipping, so nothing is proposed to a user until this has run.
//
// Method: replay every closed round trip the journal reconstructs, bar by bar,
// under each candidate stop rule. If the stop would have fired before the real
// exit, the trade is re-priced at the trigger and compared with what actually
// happened.
//
// Three properties this measurement has to have, or it is decoration:
//
// 1. IT MUST COUNT THE COST. Stops do not only cut losses, they cut winners
//    short and convert unrealised losses into realised ones. A study that
//    reports only losses-avoided will recommend a stop on every rule. So
//    winnersCutShort and the P&L given up on them are reported next to the
//    savings, and the headline is the NET.
//
// 2. IT MUST SWEEP. The parameters are arbitrary until measured. A result that
//    appears at one setting and vanishes at its neighbours is a property of the
//    setting, not of the market.
//
// 3. IT MUST BE CAUSAL. The stop level at bar i uses bars <= i only, and a stop
//    can only fire on a bar at or after entry. Every indicator here is causal by
//    construction, but the replay is written so that is visible rather than
//    assumed.
//
// Fills are modelled at the trigger price. Real SL-M fills are at market after
// the trigger, so in a gap-down the true fill is worse — this study therefore
// flatters stops slightly, which is the safe direction for a gate that decides
// whether to offer them at all.

const YahooFinance = require('yahoo-finance2').default;
const { ATR } = require('technicalindicators');
const { computeSuperTrend, padLeft } = require('./backtest/indicators');

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const WARMUP_DAYS = 200;   // calendar days of lead-in for ATR / SuperTrend
// Yahoo treats period2 as EXCLUSIVE, so asking for data up to the exit date
// returns bars ending the day BEFORE it. Every trip that defined its symbol's
// span then failed its own exit lookup and was skipped in silence — the first
// run evaluated 4-6 trips out of 49 and looked like a clean "too few to judge".
const TAIL_PAD_DAYS = 10;
const MIN_TRIPS = 20;      // below this, no verdict — matches signalScoring
const FETCH_GAP_MS = 120;

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const r2 = (v) => (v == null || !isFinite(v) ? null : +v.toFixed(2));

/**
 * Stop level per bar, for each candidate rule. Each returns an array aligned to
 * `bars`, null while the rule has no opinion yet (warmup).
 *
 * All of these TRAIL: the level may rise but never falls, because a protective
 * stop that loosens as price drops is not protecting anything.
 */
function stopSeries(bars, rule) {
  const n = bars.length;
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const closes = bars.map(b => b.close);
  const atr14 = padLeft(ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }), n);
  const out = new Array(n).fill(null);

  if (rule.kind === 'donchian') {
    // The level server.js already computes for its trade plan: the low of the
    // prior N bars, less a small ATR buffer so ordinary noise does not trip it.
    for (let i = rule.window; i < n; i++) {
      let lo = Infinity;
      for (let k = i - rule.window; k < i; k++) if (lows[k] < lo) lo = lows[k];
      if (lo === Infinity) continue;
      out[i] = lo - (atr14[i] ?? 0) * rule.atrBuffer;
    }
  } else if (rule.kind === 'atr') {
    for (let i = 0; i < n; i++) {
      if (atr14[i] == null) continue;
      out[i] = closes[i] - atr14[i] * rule.mult;
    }
  } else if (rule.kind === 'supertrend') {
    const atrRaw = ATR.calculate({ high: highs, low: lows, close: closes, period: rule.period });
    const st = padLeft(computeSuperTrend(bars, atrRaw, rule.period, rule.mult), n);
    for (let i = 0; i < n; i++) {
      // Only meaningful as a stop while the trend is up; in a downtrend the
      // band sits above price and would fire instantly.
      if (st[i]?.direction === 'BULL') out[i] = st[i].value;
    }
  } else if (rule.kind === 'fixed') {
    return null; // handled in the replay — it is anchored to entry, not to bars
  }
  return out;
}

/**
 * Replay one trip under one rule.
 *
 * @param bars     daily bars covering warmup + the holding period
 * @param entryIdx index of the entry bar
 * @param exitIdx  index of the actual exit bar
 * @returns { stopped, stopIdx, stopPrice }
 */
function replayStop(bars, entryIdx, exitIdx, rule, entryPrice) {
  if (rule.kind === 'fixed') {
    const level = entryPrice * (1 - rule.pct / 100);
    for (let i = entryIdx; i <= exitIdx; i++) {
      if (bars[i].low <= level) return { stopped: true, stopIdx: i, stopPrice: level };
    }
    return { stopped: false };
  }

  const series = stopSeries(bars, rule);
  let trail = null;
  for (let i = entryIdx; i <= exitIdx; i++) {
    // Ratchet on the PREVIOUS bar's level, so the stop in force during bar i was
    // knowable before bar i traded. Using bar i's own level would let a stop
    // move up on the very bar it is being tested against.
    const prev = i > 0 ? series?.[i - 1] : null;
    if (prev != null && (trail == null || prev > trail)) trail = prev;
    if (trail != null && bars[i].low <= trail) {
      return { stopped: true, stopIdx: i, stopPrice: trail };
    }
  }
  return { stopped: false };
}

/** Yahoo daily bars. NSE first, BSE as fallback for names NSE does not carry. */
async function fetchBars(symbol, from, to) {
  for (const suffix of ['.NS', '.BO']) {
    try {
      const c = await yf.chart(`${symbol}${suffix}`, { period1: from, period2: to, interval: '1d' }, { validateResult: false });
      const bars = (c.quotes || [])
        .filter(q => q.close != null && q.high != null && q.low != null)
        .map(q => ({ date: q.date.toISOString().slice(0, 10), high: q.high, low: q.low, close: q.close }));
      if (bars.length > 30) return bars;
    } catch { /* try the other venue */ }
  }
  return null;
}

const RULES = [
  { name: 'donchian-20 -0.3ATR', kind: 'donchian', window: 20, atrBuffer: 0.3 },
  { name: 'donchian-50 -0.3ATR', kind: 'donchian', window: 50, atrBuffer: 0.3 },
  { name: 'supertrend(10,3)', kind: 'supertrend', period: 10, mult: 3 },
  { name: 'atr-trail 2.0x', kind: 'atr', mult: 2 },
  { name: 'atr-trail 2.5x', kind: 'atr', mult: 2.5 },
  { name: 'atr-trail 3.0x', kind: 'atr', mult: 3 },
  { name: 'atr-trail 4.0x', kind: 'atr', mult: 4 },
  { name: 'fixed -8%', kind: 'fixed', pct: 8 },
  { name: 'fixed -12%', kind: 'fixed', pct: 12 },
  { name: 'fixed -15%', kind: 'fixed', pct: 15 },
];

const isoMinus = (iso, days) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};
const isoPlus = (iso, days) => isoMinus(iso, -days);

// Entry takes the first bar on or after the date; exit takes the last bar on or
// before it. Exact-date lookups break on holidays and on the final bar of a
// window, and a missed lookup previously dropped the whole trip rather than
// failing loudly.
const idxAtOrAfter = (bars, d) => { const i = bars.findIndex(b => b.date >= d); return i < 0 ? null : i; };
const idxAtOrBefore = (bars, d) => {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].date <= d) return i;
  return null;
};

/**
 * @param trips  round trips from journal/engine buildRoundTrips, each carrying
 *               { symbol, entryDate, exitDate, qty, entryAvg, exitAvg, pnl }
 */
async function runStopStudy(trips, { onProgress = null } = {}) {
  if (!trips?.length) throw new Error('No closed round trips to study');

  // One fetch per symbol, spanning every trip in it.
  const spans = new Map();
  for (const t of trips) {
    const s = spans.get(t.symbol) || { from: t.entryDate, to: t.exitDate };
    if (t.entryDate < s.from) s.from = t.entryDate;
    if (t.exitDate > s.to) s.to = t.exitDate;
    spans.set(t.symbol, s);
  }

  const barsBySymbol = new Map();
  let fetched = 0, missing = 0;
  for (const [symbol, span] of spans) {
    const bars = await fetchBars(symbol, isoMinus(span.from, WARMUP_DAYS), isoPlus(span.to, TAIL_PAD_DAYS));
    if (bars) barsBySymbol.set(symbol, bars); else missing++;
    fetched++;
    if (onProgress) onProgress({ fetched, total: spans.size, missing });
    await new Promise(r => setTimeout(r, FETCH_GAP_MS));
  }

  const usable = trips.filter(t => barsBySymbol.has(t.symbol));
  const results = RULES.map(rule => {
    let stoppedCount = 0, winnersCut = 0, losersSaved = 0, unreplayable = 0;
    let deltaTotal = 0, givenUpOnWinners = 0, savedOnLosers = 0;
    const perTrip = [];

    for (const t of usable) {
      const bars = barsBySymbol.get(t.symbol);
      const entryIdx = idxAtOrAfter(bars, t.entryDate);
      const exitIdx = idxAtOrBefore(bars, t.exitDate);
      if (entryIdx == null || exitIdx == null || exitIdx <= entryIdx) { unreplayable++; continue; }

      const r = replayStop(bars, entryIdx, exitIdx, rule, t.entryAvg);
      if (!r.stopped) continue;

      stoppedCount++;
      // Same quantity, different exit price. Costs are not modelled either way,
      // so the comparison is like for like.
      const stoppedPnl = (r.stopPrice - t.entryAvg) * t.qty;
      const delta = stoppedPnl - t.pnl;
      deltaTotal += delta;
      if (t.pnl > 0) { winnersCut++; givenUpOnWinners += delta; }
      else { losersSaved++; savedOnLosers += delta; }
      perTrip.push({
        symbol: t.symbol, entryDate: t.entryDate, exitDate: t.exitDate,
        stopDate: bars[r.stopIdx].date, actualPnl: r2(t.pnl), stoppedPnl: r2(stoppedPnl), delta: r2(delta),
      });
    }

    return {
      rule: rule.name,
      tripsEvaluated: usable.length - unreplayable,
      tripsUnreplayable: unreplayable,
      tripsStopped: stoppedCount,
      winnersCutShort: winnersCut,
      losersStoppedEarly: losersSaved,
      pnlGivenUpOnWinners: r2(givenUpOnWinners),
      pnlSavedOnLosers: r2(savedOnLosers),
      netDelta: r2(deltaTotal),
      underSampled: stoppedCount < MIN_TRIPS,
      verdict: !stoppedCount ? 'never fired'
        : stoppedCount < MIN_TRIPS ? `only ${stoppedCount} trips stopped — too few to judge`
        : `${deltaTotal >= 0 ? 'better' : 'worse'} by Rs ${Math.abs(Math.round(deltaTotal)).toLocaleString('en-IN')} across ${stoppedCount} stopped trips`,
      worstCuts: perTrip.filter(p => p.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 3),
    };
  });

  results.sort((a, b) => (b.netDelta ?? -Infinity) - (a.netDelta ?? -Infinity));

  return {
    trips: { total: trips.length, usable: usable.length, symbolsMissingPrices: missing },
    actualTotalPnl: r2(sum(usable.map(t => t.pnl))),
    minTrips: MIN_TRIPS,
    results,
    caveats: [
      'Fills are modelled at the trigger price. A real SL-M fills at market after the trigger, so a gap-down fills worse — this study flatters stops, which is the safe direction for a go/no-go gate.',
      'Costs, slippage and taxes are not modelled on either side, so the comparison is like for like but not a P&L forecast.',
      'Only trips whose symbol still resolves on Yahoo are replayed; delisted or renamed names drop out.',
      'A stop that fires converts an unrealised loss into a realised one and ends the trade — the capital freed is not redeployed here, so the study understates a stop rule that would have let you re-enter better.',
      'These are the same trades the journal scores, so the sample is one trader over two years, not a general result about stops.',
    ],
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runStopStudy, replayStop, stopSeries, RULES, MIN_TRIPS };
