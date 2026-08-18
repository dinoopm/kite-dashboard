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

// Relative volume, and the claim built on it: a DEMAND thrust — volume at least
// VOLUME_THRUST_MULT × its own 20-session baseline on a day the close is up.
//
// Three decisions worth stating, because each one changes what the number means.
//
// 1. The baseline excludes the bar being measured. buildSeries' vol20avg[i] sums
//    the 20 bars ENDING AT i-1, so a 5× day is not diluted into a 4.2× day by
//    sitting inside its own average — and the threshold means the same thing on
//    a quiet symbol as on a busy one.
// 2. Volume on its own has no direction. A 3× day that closes down is
//    distribution; pooling it with a 3× day that closes up averages two opposite
//    claims into one meaningless one. Only the up-close case fires here. The
//    down-volume version is a different signal and is NOT claimed by this one.
// 3. News puts a stock "in play" for several sessions, so heavy up days arrive
//    in runs. A run is one call, not four — see rule 1 at the top of this file —
//    so a thrust only counts on the first day of it.
const VOLUME_THRUST_MULT = 2;

/** volume / trailing-20 average at bar i, or null while the baseline is unwarm. */
function relativeVolume(S, i) {
  const avg = S.vol20avg[i];
  if (avg == null || !(avg > 0)) return null;
  const v = S.volumes[i];
  if (v == null) return null;
  return v / avg;
}

/**
 * Does bar i meet the bar (heavy volume, up close), run-position ignored?
 *
 * `mult` is a parameter only so volumeThrustStudy.js can sweep it — the shipped
 * signal is always VOLUME_THRUST_MULT. A threshold picked by eye and never
 * varied is indistinguishable from a threshold picked to flatter the result,
 * so the study reports the whole grid and this is what lets it.
 */
function isThrustBar(S, i, mult = VOLUME_THRUST_MULT) {
  const ratio = relativeVolume(S, i);
  if (ratio == null || ratio < mult) return false;
  const prevClose = S.closes[i - 1];
  return prevClose != null && S.closes[i] > prevClose;
}

/** The thrust itself: bar i meets the bar and bar i-1 did not. */
function volumeThrust(S, i, mult = VOLUME_THRUST_MULT) {
  if (!isThrustBar(S, i, mult) || isThrustBar(S, i - 1, mult)) return null;
  return {
    close: S.closes[i],
    volRatio: +relativeVolume(S, i).toFixed(2),
    avgVol: Math.round(S.vol20avg[i]),
  };
}

// ─── The chart's own Buy signal, and what volume does to it ──────────────────
//
// The Signals tab has drawn 10/50 golden-cross Buy markers since long before
// this registry existed, and nothing has ever measured them. That is the gap
// these three entries close, and they are deliberately three rather than one:
//
//   ma_cross_up     every actionable buy — the baseline
//   ma_cross_volume the ones a volume thrust confirms
//   ma_cross_quiet  the ones it does not
//
// The last two are DISJOINT and together make up the first. That matters: a
// confirmed-vs-baseline comparison is nearly meaningless, because the baseline
// contains the confirmed firings and drags toward them. Confirmed vs quiet is
// the comparison that can actually say whether volume adds anything, so the
// registry records the split rather than leaving it to be eyeballed later.
//
// India cannot answer the question quickly: bhavcopy starts 2026-04-02 and a
// cross needs 50 bars before it can fire at all, so the halves take time to
// fill. volumeThrustStudy.js asks the same question of a decade of US history
// in the meantime — evidence about the RULE, not about Indian stocks, which is
// what these entries will eventually supply.
//
// The rule is ported from frontend/src/lib/signalEngine.js, including its
// dead-cat guard, because a badge must describe the markers on screen. The
// chart's period sliders can move off 10/50; the UI hides the badge when they
// do, since at that point the markers are a variant nothing has scored.
const CROSS_FAST = 10;
const CROSS_SLOW = 50;
const CROSS_MID = 20;    // Bollinger basis, used only by the dead-cat guard
const DROP_LOOKBACK = 10;
const DROP_PCT = 0.10;

// A thrust anywhere in this window confirms the cross. Zero would be too
// strict to mean anything: a 50-bar SMA turns days after the buying that moved
// it, so demanding the heavy day land exactly on the crossover bar would
// mostly measure SMA lag. Swept in volumeThrustStudy.js rather than asserted.
const CONFIRM_WINDOW = 5;

/** SMA(period) over closes, computed once per series and cached on it. */
function smaSeries(S, period) {
  if (!S._sma) S._sma = {};
  if (S._sma[period]) return S._sma[period];
  const out = new Array(S.closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < S.closes.length; i++) {
    sum += S.closes[i];
    if (i >= period) sum -= S.closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  S._sma[period] = out;
  return out;
}

/** The golden cross itself: fast was at or below slow, and now is above. */
function crossedUpAt(S, i) {
  const f = smaSeries(S, CROSS_FAST);
  const sl = smaSeries(S, CROSS_SLOW);
  if (f[i] == null || sl[i] == null || f[i - 1] == null || sl[i - 1] == null) return false;
  return f[i - 1] <= sl[i - 1] && f[i] > sl[i];
}

/**
 * The chart's dead-cat-bounce guard: a cross that fires below the 20-bar mean
 * right after a sharp drop is usually a failed bounce. The UI already excludes
 * these from its buy tally, so scoring them as buys would score a rule nobody
 * is shown.
 */
function deadCatAt(S, i) {
  const mid = smaSeries(S, CROSS_MID)[i];
  if (mid == null || !(S.closes[i] < mid)) return false;
  let peak = -Infinity;
  for (let j = Math.max(0, i - DROP_LOOKBACK); j <= i; j++) peak = Math.max(peak, S.closes[j]);
  return peak > 0 && (peak - S.closes[i]) / peak >= DROP_PCT;
}

/**
 * Index of the most recent bar within `window` sessions of i that met the
 * volume bar, or -1.
 *
 * This uses isThrustBar, not volumeThrust: the run guard exists to stop one
 * episode being RECORDED four times, but for confirmation the question is
 * simply whether heavy demand volume showed up recently — the second day of a
 * heavy run confirms a cross just as well as the first.
 */
function thrustWithin(S, i, window = CONFIRM_WINDOW, mult = VOLUME_THRUST_MULT) {
  for (let k = i; k >= Math.max(1, i - window); k--) if (isThrustBar(S, k, mult)) return k;
  return -1;
}

/** Every actionable buy the chart draws: 10/50 cross, RSI > 50, not dead-cat. */
function maCrossUp(S, i) {
  if (!crossedUpAt(S, i)) return null;
  const rsi = S.rsi14[i];
  if (rsi == null || !(rsi > 50)) return null;
  if (deadCatAt(S, i)) return null;
  const at = thrustWithin(S, i);
  const ratio = relativeVolume(S, i);
  return {
    close: S.closes[i],
    rsi: +rsi.toFixed(1),
    // Carried on every row so the split can be re-cut later — by a wider
    // window, a different multiple — without re-recording anything.
    volRatio: ratio == null ? null : +ratio.toFixed(2),
    confirmed: at >= 0,
    confirmedBarsAgo: at >= 0 ? i - at : null,
  };
}

/** The confirmed half. */
function maCrossVolume(S, i) {
  const hit = maCrossUp(S, i);
  return hit && hit.confirmed ? hit : null;
}

/** The unconfirmed half — the control group, and the reason this is scoreable. */
function maCrossQuiet(S, i) {
  const hit = maCrossUp(S, i);
  return hit && !hit.confirmed ? hit : null;
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
  {
    name: 'volume_thrust',
    label: 'Volume thrust (2× on an up day)',
    description: 'Volume at least 2× the trailing 20-session average on a day the close is up, and only on the first such day of a run.',
    // 20 bars of baseline, plus one more so the previous bar can be tested for
    // the run guard, plus one before THAT for its own up/down close. Starting a
    // bar earlier would make the guard read an undefined close and silently
    // treat the second day of a run as a fresh firing.
    minBars: 22,
    source: 'reconstructed',
    detect: volumeThrust,
  },
  {
    name: 'ma_cross_up',
    label: 'Golden cross buy (10/50, RSI>50)',
    description: 'The Buy marker the Signals tab has always drawn: SMA10 crosses above SMA50 with RSI over 50, dead-cat bounces excluded. Registered as the baseline the volume-confirmed variant is measured against.',
    // SMA50 needs 50 bars and the cross test reads bar i-1, so bar 50 is the
    // first that can fire at all.
    minBars: 51,
    source: 'reconstructed',
    detect: maCrossUp,
  },
  {
    name: 'ma_cross_volume',
    label: 'Golden cross, volume-confirmed',
    description: `The same buy, when a volume thrust (2× the 20-session average on an up close) landed on the cross bar or within the prior ${CONFIRM_WINDOW} sessions. Disjoint from ma_cross_quiet; the two together are ma_cross_up, so their n must never be added.`,
    minBars: 51,
    source: 'reconstructed',
    detect: maCrossVolume,
  },
  {
    name: 'ma_cross_quiet',
    label: 'Golden cross, no volume behind it',
    description: 'The same buy with no volume thrust in the confirmation window. This is the control group: volume confirmation is only worth applying as a filter if these do measurably worse.',
    minBars: 51,
    source: 'reconstructed',
    detect: maCrossQuiet,
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
  volumeThrust, isThrustBar, relativeVolume, VOLUME_THRUST_MULT,
  maCrossUp, maCrossVolume, maCrossQuiet, crossedUpAt, deadCatAt, thrustWithin, smaSeries,
  CROSS_FAST, CROSS_SLOW, CONFIRM_WINDOW,
};
