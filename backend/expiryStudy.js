// ─── Does expiry actually move volatility? ───────────────────────────────────
//
// "Expiry week is volatile" is folklore that every dashboard repeats and none
// of them check. This measures it: NIFTY's own realized volatility on monthly
// derivatives-expiry sessions against every other session, over as much history
// as the index feed provides.
//
// Same shape as macroStudy.js — an event set, a baseline, and base rates for
// both — because the honest answer to "is X volatile?" is always "compared to
// what?".
//
// Two volatility measures, deliberately:
//   · intraday range (high−low)/close — what a day actually felt like
//   · absolute close-to-close return — what it did to a position held overnight
// They can disagree. A day can thrash inside a range and close flat, which is
// exactly the pattern expiry pinning would produce, so collapsing them into one
// number would hide the interesting case.
//
// The verdict refuses to speak below a usable sample and reports Welch's t on
// the difference of means, because a 15% gap on nine expiries is noise.

const YahooFinance = require('yahoo-finance2').default;
const { monthlyExpiries, nextExpiry, classifySessions, verifyAgainstVolume } = require('./expiryCalendar');

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const INDEX = '^NSEI';
const HISTORY_FROM = '2015-01-01';
const MIN_N = 20;          // below this, no direction is called
const WINDOW = 3;          // sessions either side counted as "expiry window"

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const variance = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
};

/**
 * Welch's t — unequal variances, which is the realistic case here since the
 * whole hypothesis is that one group is more dispersed than the other.
 */
function welchT(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const va = variance(a) / a.length;
  const vb = variance(b) / b.length;
  if (!va && !vb) return null;
  return (mean(a) - mean(b)) / Math.sqrt(va + vb);
}

/** Per-session volatility measures from index OHLC. */
function sessionVol(bars) {
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    if (!Number.isFinite(b.close) || b.close === 0) continue;
    out.push({
      date: b.date,
      rangePct: Number.isFinite(b.high) && Number.isFinite(b.low)
        ? ((b.high - b.low) / b.close) * 100 : null,
      absRetPct: prev && Number.isFinite(prev.close) && prev.close !== 0
        ? Math.abs((b.close - prev.close) / prev.close) * 100 : null,
      retPct: prev && Number.isFinite(prev.close) && prev.close !== 0
        ? ((b.close - prev.close) / prev.close) * 100 : null,
    });
  }
  return out;
}

/**
 * Compare one measure between an event group and a baseline group.
 *
 * `signed: true` for measures that straddle zero (a return). A ratio of medians
 * is meaningless there — median return of −0.001% against +0.062% came out as
 * "102% lower", a number governed entirely by how close the denominator sat to
 * zero. Signed measures are reported as a difference in percentage points.
 * Magnitudes (range, absolute move) are strictly positive and keep the ratio,
 * where "8% higher" is the natural reading.
 */
function compareGroups(eventVals, baseVals, { minN = MIN_N, signed = false } = {}) {
  const ev = eventVals.filter(Number.isFinite);
  const bs = baseVals.filter(Number.isFinite);
  const evMed = median(ev), bsMed = median(bs);
  const ratio = (!signed && evMed != null && bsMed > 0) ? evMed / bsMed : null;
  const diff = (evMed != null && bsMed != null) ? evMed - bsMed : null;
  const t = welchT(ev, bs);
  const tRounded = t == null ? null : +t.toFixed(2);
  return {
    n: ev.length,
    nBaseline: bs.length,
    signed,
    medianEvent: evMed == null ? null : +evMed.toFixed(3),
    medianBaseline: bsMed == null ? null : +bsMed.toFixed(3),
    meanEvent: mean(ev) == null ? null : +mean(ev).toFixed(3),
    meanBaseline: mean(bs) == null ? null : +mean(bs).toFixed(3),
    ratio: ratio == null ? null : +ratio.toFixed(3),
    diffPp: diff == null ? null : +diff.toFixed(3),
    tStat: tRounded,
    underSampled: ev.length < minN,
    verdict: describe({ n: ev.length, ratio, diff, t: tRounded, minN, signed }),
  };
}

function describe({ n, ratio, diff, t, minN, signed }) {
  if (!n) return 'no sessions';
  if (n < minN) return `n=${n} — too few to judge`;
  const size = signed
    ? (diff == null ? null : `${diff >= 0 ? '+' : '−'}${Math.abs(diff).toFixed(2)}pp`)
    : (ratio == null ? null : `${Math.round(Math.abs(ratio - 1) * 100)}% ${ratio > 1 ? 'higher' : 'lower'}`);
  if (size == null) return `n=${n}, no baseline`;
  // |t| > 2 is the usual "distinguishable from zero" rule of thumb. Below it,
  // say so plainly rather than reporting a difference that could be noise.
  if (t == null || Math.abs(t) < 2) return `${size}, but not distinguishable from noise (t=${t ?? '—'}, n=${n})`;
  return `${size} (t=${t}, n=${n})`;
}

/** ^NSEI daily bars, oldest first. */
async function fetchIndexBars(from) {
  const c = await yf.chart(INDEX, { period1: from, interval: '1d' });
  return (c.quotes || [])
    .filter(q => q.close != null)
    .map(q => ({
      date: q.date.toISOString().slice(0, 10),
      open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume,
    }));
}

/**
 * The study. Splits sessions three ways and measures each against the rest:
 *   expiryDay     — the monthly expiry session itself
 *   expiryWindow  — within ±WINDOW sessions of it
 *   preExpiry     — the sessions leading in, where rollover happens
 */
async function runExpiryStudy({ from = HISTORY_FROM } = {}) {
  const bars = await fetchIndexBars(from);
  if (bars.length < 100) throw new Error(`Only ${bars.length} index sessions available — too short to study.`);

  const calendar = bars.map(b => b.date);
  const vols = sessionVol(bars);
  const volByDate = new Map(vols.map(v => [v.date, v]));
  const classes = classifySessions(calendar, { window: WINDOW });

  const pick = (predicate, field) => classes
    .filter(predicate)
    .map(c => volByDate.get(c.date)?.[field])
    .filter(v => v != null);

  const groups = {
    expiryDay: (c) => c.isExpiry,
    expiryWindow: (c) => c.inExpiryWindow,
    preExpiry: (c) => c.offset != null && c.offset < 0 && c.offset >= -WINDOW,
  };

  const results = {};
  for (const [name, pred] of Object.entries(groups)) {
    const inverse = (c) => !pred(c);
    results[name] = {
      rangePct: compareGroups(pick(pred, 'rangePct'), pick(inverse, 'rangePct')),
      absRetPct: compareGroups(pick(pred, 'absRetPct'), pick(inverse, 'absRetPct')),
      // Direction, not just magnitude — folklore also claims expiry drifts down.
      // Signed, so this is reported as a gap in percentage points.
      retPct: compareGroups(pick(pred, 'retPct'), pick(inverse, 'retPct'), { signed: true }),
    };
  }

  // Is the expiry rule itself right? Index volume stands in for turnover.
  const turnover = new Map(bars.filter(b => Number.isFinite(b.volume)).map(b => [b.date, b.volume]));
  const ruleCheck = verifyAgainstVolume(calendar, turnover);

  const expiries = monthlyExpiries(calendar);
  // The forward-looking half: the next expiry has not traded yet, so this is
  // projected arithmetically and flagged as such.
  const todayISO = new Date().toISOString().slice(0, 10);
  const next = nextExpiry(calendar, todayISO);

  return {
    index: INDEX,
    next,
    period: { from: calendar[0], to: calendar[calendar.length - 1], sessions: calendar.length },
    expiries: { count: expiries.length, latest: expiries[expiries.length - 1] || null },
    window: WINDOW,
    minN: MIN_N,
    results,
    ruleCheck,
    caveats: [
      'Monthly expiry only — NSE has moved the weekly rule between weekdays more than once, so it is not encoded here.',
      'Expiry dates are derived (last traded Thursday of the month), not taken from an instrument feed. ruleCheck compares turnover on those sessions against the rest as evidence the rule still holds.',
      'Index volume stands in for cash-market turnover in ruleCheck; it is a relative measure, not rupees traded.',
      'Monthly expiries are ~12 a year, so even a decade of history is a few hundred observations — treat sub-2 t-stats as nothing.',
      'Sessions near expiry overlap month to month only rarely, but the window groups do overlap the expiry day itself, so the three groups are not independent of each other.',
    ],
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runExpiryStudy, sessionVol, compareGroups, welchT, MIN_N, WINDOW };
