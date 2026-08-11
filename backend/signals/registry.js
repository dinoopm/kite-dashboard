// ─── The signal registry ─────────────────────────────────────────────────────
//
// One place that says: here is every signal the app publishes, here is exactly
// what makes it fire, and here is how much history it needs before it can fire
// at all. Everything downstream — recording emissions, scoring them, rendering
// a track record beside the signal — reads from this list, so a signal cannot
// be added to the UI and quietly skip validation.
//
// Two rules the detectors follow, both of which exist to stop the sample from
// lying:
//
// 1. A signal fires on the TRANSITION, not on the state. "SuperTrend is bullish"
//    is true for forty days running; recording it forty times turns one call
//    into forty rows and makes n look like evidence. Only the flip counts.
//
// 2. Detectors are causal by construction: they read `series` at index i and
//    strictly before, never after. Every indicator in backtest/indicators.js is
//    itself causal, so evaluating at bar i reproduces exactly what the app
//    could have shown on the evening of bar i.
//
// `minBars` is not decoration. VCP needs a 200-day SMA for its Minervini gate;
// nse_bhavcopy currently holds ~74 sessions, so the honest answer today is that
// VCP cannot be validated at all — recorded here with that reason attached
// rather than omitted and forgotten.

const { rollingMax } = require('../backtest/indicators');
const { bandwidthSeries, squeezeMask, MIN_BARS: SQUEEZE_MIN_BARS } = require('../screener/squeeze');
const { MIN_BARS: VCP_MIN_BARS } = require('../screener/vcp');

/** Did SuperTrend flip from BEAR to BULL on bar i? */
function supertrendFlipUp(S, i) {
  const cur = S.supertrend[i]?.direction;
  const prev = S.supertrend[i - 1]?.direction;
  if (cur !== 'BULL' || prev !== 'BEAR') return null;
  return { close: S.closes[i], stop: S.supertrend[i]?.value ?? null };
}

/** Close above the highest high of the prior `window` bars — a fresh breakout. */
function breakout(window) {
  return (S, i) => {
    const prior = rollingMax(S.highs, window, i);
    if (prior == null || !(S.closes[i] > prior)) return null;
    // Yesterday's close must NOT have been above the same window, or a stock
    // grinding up a trend re-emits every single day.
    const priorYday = rollingMax(S.highs, window, i - 1);
    if (priorYday != null && S.closes[i - 1] > priorYday) return null;
    const volRatio = S.vol20avg[i] ? S.volumes[i] / S.vol20avg[i] : null;
    return {
      close: S.closes[i],
      priorHigh: +prior.toFixed(2),
      volRatio: volRatio == null ? null : +volRatio.toFixed(2),
    };
  };
}

/**
 * Did a Bollinger squeeze BEGIN on bar i?
 *
 * The screener field is the state — coiled or not, true for every bar the
 * compression lasts. This is the transition, and the difference is the whole
 * reason both exist: a squeeze running twenty bars is ONE call, and recording
 * the state daily would file it twenty times and make n look like evidence.
 *
 * The mask is computed once per symbol and cached on the series object, since
 * detectAll walks every bar and recomputing a 30-bar rolling minimum per bar
 * would make recording quadratic.
 */
function squeezeStart(S, i) {
  if (!S._bbSqueezeMask) {
    const bbw = bandwidthSeries(S.closes);
    S._bbSqueezeMask = squeezeMask(bbw);
    S._bbw = bbw;
  }
  const mask = S._bbSqueezeMask;
  if (!mask[i] || mask[i - 1]) return null;
  return {
    close: S.closes[i],
    bandwidth: S._bbw[i] == null ? null : +S._bbw[i].toFixed(2),
  };
}

// Signals derived from daily OHLCV. `source: 'reconstructed'` is an admission,
// not a formality: these are recomputed from stored bhavcopy rather than
// captured the day they fired. Bhavcopy closes are not revised and no
// survivorship or surveillance filter is applied at detection time, so the
// reconstruction is faithful — but it is still not the same evidentiary
// standard as stock_pick_snapshots, which was written before the outcome
// existed, and the scorecard labels the two differently.
const PRICE_SIGNALS = [
  {
    name: 'supertrend_flip_up',
    label: 'SuperTrend flip to bullish',
    description: 'ATR(10)×3 SuperTrend turns BULL after being BEAR. Fires once, on the flip bar.',
    minBars: 15,
    source: 'reconstructed',
    detect: supertrendFlipUp,
  },
  {
    name: 'breakout_20d',
    label: '20-day breakout',
    description: 'Close above the highest high of the prior 20 sessions, on a day it was not already above.',
    minBars: 25,
    source: 'reconstructed',
    detect: breakout(20),
  },
  {
    name: 'bb_squeeze',
    label: 'Bollinger squeeze begins',
    description: 'Bollinger bandwidth (20,2) reaches within 5% of its 30-day low, on a bar it was not already there. Fires on the transition into compression, not on every bar of it.',
    minBars: SQUEEZE_MIN_BARS + 1,
    source: 'reconstructed',
    detect: squeezeStart,
  },
  {
    name: 'breakout_55d',
    label: '55-day breakout',
    description: 'Close above the highest high of the prior 55 sessions, on a day it was not already above.',
    minBars: 60,
    source: 'reconstructed',
    detect: breakout(55),
  },
];

// Signals that cannot be evaluated from the history currently stored. Kept in
// the registry on purpose: a signal the dashboard displays but nobody can score
// should be visibly unscored, not silently absent from the scorecard.
const BLOCKED_SIGNALS = [
  {
    name: 'vcp_setup',
    label: 'VCP setup',
    minBars: 200 + VCP_MIN_BARS,
    source: 'reconstructed',
    blockedReason: 'The Minervini gate needs a 200-day SMA plus a 60-bar base. nse_bhavcopy starts 2026-04-02, so no bar has enough history yet; this becomes scoreable once roughly a year of bhavcopy has accumulated.',
  },
  {
    name: 'base_breakout',
    label: 'Year-long base → fresh BUY',
    minBars: 252 + 50,
    source: 'reconstructed',
    blockedReason: 'Not scoreable on Indian data: the premise is a YEAR of going nowhere, so one firing needs 252 sessions before it, and nse_bhavcopy holds ~82. Becomes measurable here around mid-2027. It HAS been measured on US history instead — backend/baseBreakoutStudy.js, 498 S&P 500 names over 2014-2026, 2,358 firings at the tight setting: 22-day median excess over the index +0.48% (t=4.1), decaying smoothly to nothing as the base is allowed to widen, and no effect at all at 5 or 10 days. Real but small, and the universe is today\'s index members, so survivorship bias flatters it by an unknown amount. Treat as a research filter, not an edge.',
  },
  {
    name: 'us_macro_regime',
    label: 'US macro regime (cooling / neutral / re-accelerating)',
    source: 'recorded',
    blockedReason: 'A market-wide claim, not a per-symbol one, so signals/scorecard.js — which measures each symbol against an index — cannot express it, the same reason expiry_volatility sits here. It IS recorded before the outcome exists: dailyJobs writes macro_signal_snapshots every day. What it is not yet is SCORED, and the binding constraint is sample size of the right unit. A regime is a STATE that persists for months, and this repo\'s first rule is that signals fire on transitions, not states — counting "re-accelerating" on each of five consecutive months turns one call into five heavily overlapping rows and inflates n fivefold. The honest unit is the transition, of which live recording yields roughly 4-8 a year. A credible sample needs the ALFRED vintage reconstruction (FRED_API_KEY + macro/ingest.js runIngest({ mode: "backfill", asOf }) walked back through history), which would give on the order of 60-90 transitions since 2000 using data as it was actually known at the time rather than as later revised. Until that exists, treat the panel as a data display, not as evidence about anything.',
  },
  {
    name: 'expiry_volatility',
    label: 'Monthly expiry volatility',
    source: 'recorded',
    blockedReason: 'A market-wide claim, not a per-symbol one, so this scorer — which measures each symbol against the index — cannot express it. It IS measured, by backend/expiryStudy.js against every non-expiry session since 2015: over 139 monthly expiries the effect is within noise (intraday range 6% wider, t=0.11). Registered here so a signal that fires on the whole market is not simply absent from the list.',
  },
];

// Signals captured at publication time rather than recomputed. These carry the
// strongest evidence, because the row existed before the outcome did.
const RECORDED_SIGNALS = [
  { name: 'picks_top25', label: 'Quant picks (top 25)', source: 'recorded', description: 'Every symbol written to stock_pick_snapshots that day.' },
  { name: 'picks_top10', label: 'Quant picks (top 10)', source: 'recorded', description: 'The top 10 of the same snapshot — tests whether rank ordering carries information.' },
  { name: 'high_52w',    label: 'New 52-week high',     source: 'recorded', description: 'nse_52_week_high_low reported the stock set its 52-week high that session.' },
];

const ALL_SIGNALS = [...PRICE_SIGNALS, ...RECORDED_SIGNALS, ...BLOCKED_SIGNALS];
const signalMeta = (name) => ALL_SIGNALS.find(s => s.name === name) || null;

/**
 * Run every price detector across one symbol's series.
 *
 * `fromDate` skips dates already recorded, so a daily run is cheap and a
 * backfill is the same code path with an earlier start.
 */
function detectAll(S, { fromDate = null } = {}) {
  const out = [];
  for (const sig of PRICE_SIGNALS) {
    for (let i = Math.max(1, sig.minBars); i < S.dates.length; i++) {
      if (fromDate && S.dates[i] < fromDate) continue;
      const meta = sig.detect(S, i);
      if (meta) out.push({ signal: sig.name, date: S.dates[i], meta });
    }
  }
  return out;
}

module.exports = {
  PRICE_SIGNALS, RECORDED_SIGNALS, BLOCKED_SIGNALS, ALL_SIGNALS,
  signalMeta, detectAll, supertrendFlipUp, breakout, squeezeStart,
};
