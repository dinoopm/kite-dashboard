// ─── Six-month macro arithmetic ──────────────────────────────────────────────
//
// Pure functions over observation arrays. No fetching, no database, so the
// maths stays testable and the transform choice stays visible.
//
// The one rule that matters here: WHICH transform a series gets is a property
// of the series, declared in series.js, never inferred at the call site. Get it
// wrong in the obvious direction and the dashboard reports that unemployment
// rose "20%" when it went 3.5 -> 4.2. That is +0.7 percentage points. Percent
// change of a rate is not a quantity anyone in macro uses, it exaggerates
// small moves without bound as the base shrinks, and on a negative-to-more-
// negative move it returns a POSITIVE number for a series that fell — so a UI
// colouring by sign renders accelerating deflation in green.
//
//   index  → annualized 3m/6m inflation, plus year-over-year
//   price  → percent rate of change
//   rate   → percentage-point change (already a percent)
//   count  → change in the series' own units (payrolls: thousands of jobs)
//
// `computeMetrics` returns null for a reading it cannot support rather than a
// zero, because a broken feed that reads "no change" is worse than one that
// reads "unknown".

const TRANSFORMS = new Set(['index', 'price', 'rate', 'count']);

// How far from the target date an observation may sit and still count as that
// date's reading. A monthly series is stamped on the 1st, so a 45-day window
// reaches the neighbouring month; a daily series must stay tight or a holiday
// gap silently becomes a week-old quote.
const TOLERANCE_DAYS = { daily: 10, weekly: 14, monthly: 45, quarterly: 100 };

const DAY_MS = 86400000;

/**
 * FRED writes "." for a date it has no observation for — holidays on daily
 * series, months before a series began. Coerced to 0 that is a crude oil price
 * of zero; kept as NaN it poisons every downstream sum. Null is the only
 * honest answer, and a real 0 is preserved as data.
 */
function parseFredValue(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * The same calendar day six months earlier, clamped to a real date.
 *
 * Date arithmetic here is deliberate: minus-180-days lands in the wrong month
 * (six months is 181-184 days), and naive month subtraction produces
 * 2026-02-31, which Date rolls forward into March — turning a six-month window
 * into a seven-month one without any error.
 */
function sixMonthsBefore(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);                       // avoid the roll-forward while shifting
  d.setUTCMonth(d.getUTCMonth() - 6);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

/**
 * Closest observation with a value to `targetDate`, within `toleranceDays`.
 *
 * The tolerance is a hard gate, not a preference. Reaching past it to find
 * *something* produces a "six-month change" measured over eleven months, which
 * is a wrong number rather than a stale one — and wrong numbers rendered to two
 * decimal places are exactly what this codebase is trying to stop shipping.
 */
function findClosest(observations, targetDate, toleranceDays) {
  const target = Date.parse(`${String(targetDate).slice(0, 10)}T00:00:00Z`);
  let best = null;
  for (const o of observations || []) {
    if (o?.value == null || !Number.isFinite(o.value)) continue;
    const days = Math.abs(Date.parse(`${String(o.observation_date).slice(0, 10)}T00:00:00Z`) - target) / DAY_MS;
    if (days > toleranceDays) continue;
    if (!best || days < best.offsetDays) best = { value: o.value, date: String(o.observation_date).slice(0, 10), offsetDays: days };
  }
  return best;
}

/**
 * The observation for a specific MONTH, matched on the period date.
 *
 * Monthly series are stamped on the 1st, so a nearest-within-45-days search
 * will happily accept the neighbouring month: with May missing, April sits 30
 * days from the May target and June 31, so April wins and a three-month
 * average quietly spans four. Exact year-month is the only safe match.
 *
 * When the exact month is absent this falls back to the nearest EARLIER
 * observation and says so via `exact: false`, never to a later one — a later
 * observation shortens the window while still being labelled six months.
 */
function findMonth(rows, targetDate) {
  const want = String(targetDate).slice(0, 7);
  for (const r of rows) {
    if (r.observation_date.slice(0, 7) === want) {
      return { value: r.value, date: r.observation_date, offsetDays: 0, exact: true };
    }
  }
  let earlier = null;
  for (const r of rows) {
    if (r.observation_date < targetDate) earlier = r; else break;
  }
  if (!earlier) return null;
  const offsetDays = Math.round(
    (Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${earlier.observation_date}T00:00:00Z`)) / DAY_MS);
  return { value: earlier.value, date: earlier.observation_date, offsetDays, exact: false };
}

/** Percent rate of change of a level. Null base means no answer, not infinity. */
function roc(latest, base) {
  if (latest == null || base == null || !Number.isFinite(latest) || !Number.isFinite(base) || base === 0) return null;
  return ((latest / base) - 1) * 100;
}

/** Difference in percentage points, for series that are already percentages. */
function changePp(latest, base) {
  if (latest == null || base == null || !Number.isFinite(latest) || !Number.isFinite(base)) return null;
  return latest - base;
}

/**
 * Compound an index move over `months` into an annual rate.
 *
 * This is what "core PCE is running at 2.4%" means when quoted off a 3- or
 * 6-month window: the pace of the last few months, projected forward, which
 * turns faster than year-over-year does and is why the Fed and the press watch
 * it. A negative or zero base has no meaningful ratio.
 */
function annualizedRate(latestIndex, priorIndex, months) {
  if (latestIndex == null || priorIndex == null) return null;
  if (!Number.isFinite(latestIndex) || !Number.isFinite(priorIndex)) return null;
  if (priorIndex <= 0 || latestIndex <= 0 || !months) return null;
  return (Math.pow(latestIndex / priorIndex, 12 / months) - 1) * 100;
}

/** Observations with a value, oldest first. */
const clean = (observations) => (observations || [])
  .filter(o => o?.value != null && Number.isFinite(o.value))
  .map(o => ({ observation_date: String(o.observation_date).slice(0, 10), value: o.value }))
  .sort((a, b) => (a.observation_date < b.observation_date ? -1 : 1));

/**
 * Every reading the scoring layer needs from one series.
 *
 * `anchorDate` defaults to today but is a parameter so a reconstruction can ask
 * what this looked like on a past date without the answer drifting with the
 * wall clock.
 */
function computeMetrics(observations, { frequency = 'monthly', transform, anchorDate = null } = {}) {
  if (!TRANSFORMS.has(transform)) {
    throw new Error(`Unknown transform "${transform}" — declare one of ${[...TRANSFORMS].join(', ')} in series.js`);
  }
  const rows = clean(observations);
  const tol = TOLERANCE_DAYS[frequency] ?? 45;

  const empty = {
    latest: null, latestDate: null, ageDays: null,
    sixMonthsAgo: null, sixMonthsAgoDate: null,
    rocPct: null, changePp: null, annualized1m: null, annualized3m: null, annualized6m: null,
    yoyPct: null, momPct: null, avg3mChange: null, lastChange: null, monthlyChanges: [],
    observations: rows.length,
  };
  if (!rows.length) return empty;

  const last = rows[rows.length - 1];
  const anchor = anchorDate ? String(anchorDate).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const ageDays = Math.round((Date.parse(`${anchor}T00:00:00Z`) - Date.parse(`${last.observation_date}T00:00:00Z`)) / DAY_MS);

  // Windows are measured back from the LATEST OBSERVATION, not from today.
  // Anchoring on today would shorten the window by the release lag — core PCE
  // publishes about a month late, so "six months back from today" is seven
  // months of data for that series and six for oil.
  // Monthly series match on the exact period month; daily series fall back to
  // nearest-within-tolerance, which is right for them because a target date
  // routinely lands on a weekend or a holiday.
  const isMonthly = frequency === 'monthly' || frequency === 'quarterly';
  const lookup = (targetIso) => (isMonthly ? findMonth(rows, targetIso) : findClosest(rows, targetIso, tol));

  const back = (m) => {
    const d = new Date(`${last.observation_date}T00:00:00Z`);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - m);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
    return lookup(d.toISOString().slice(0, 10));
  };

  const six = lookup(sixMonthsBefore(last.observation_date));
  const three = back(3);
  const twelve = back(12);

  const out = {
    ...empty,
    latest: last.value,
    latestDate: last.observation_date,
    ageDays,
    sixMonthsAgo: six?.value ?? null,
    sixMonthsAgoDate: six?.date ?? null,
    observations: rows.length,
  };

  if (transform === 'index') {
    out.annualized3m = three ? annualizedRate(last.value, three.value, 3) : null;
    out.annualized6m = six ? annualizedRate(last.value, six.value, 6) : null;
    out.yoyPct = twelve ? roc(last.value, twelve.value) : null;
    // Month-over-month, because it is half of what every CPI headline quotes
    // and the panel otherwise reports only a transform the news never uses. A
    // reader checking "core CPI rose 0.2%" against a 2.42% annualized figure
    // will conclude the dashboard is wrong; both are right and they are
    // different quantities.
    const prevMonth = back(1);
    out.momPct = prevMonth ? roc(last.value, prevMonth.value) : null;
    // The same monthly move on the panel's own footing. "+0.2% month-over-month"
    // and "2.62% annualized" are one number said two ways, and putting them side
    // by side is what lets a reader carry a BLS headline straight onto a panel
    // that speaks in annualized rates.
    out.annualized1m = prevMonth ? annualizedRate(last.value, prevMonth.value, 1) : null;
    out.rocPct = six ? roc(last.value, six.value) : null;   // display only
  } else if (transform === 'price') {
    out.rocPct = six ? roc(last.value, six.value) : null;
  } else if (transform === 'rate') {
    out.changePp = six ? changePp(last.value, six.value) : null;
  } else if (transform === 'count') {
    // Date-matched, not positional. rows[length-4] assumes the series has no
    // gaps and no duplicate months; one missing month silently turns a
    // "3-month average" into a 4-month one at the same denominator. Every
    // other window in this file matches on the period date, and this one now
    // does too.
    const steps = [back(0), back(1), back(2), back(3)];
    const monthly = [];
    for (let i = 0; i < 3; i++) {
      const now = steps[i], prev = steps[i + 1];
      // Both ends must be the exact month, or the "monthly change" spans two
      // months at one month's label and the average is wrong by a whole
      // period. Better to report nothing.
      if (!now || !prev || now.exact === false || prev.exact === false) continue;
      monthly.push({ date: now.date, from: prev.date, change: now.value - prev.value });
    }
    // Oldest first, so the UI reads "May +63k · Jun +20k · Jul -23k".
    out.monthlyChanges = monthly.reverse();
    out.lastChange = monthly.length ? monthly[monthly.length - 1].change : null;
    // Averaged over the three first differences — identical to
    // (latest - threeMonthsBack) / 3 when no month is missing, and correct
    // rather than merely plausible when one is.
    out.avg3mChange = out.monthlyChanges.length === 3
      ? out.monthlyChanges.reduce((s, m) => s + m.change, 0) / 3
      : null;
  }

  return out;
}

/**
 * How many releases a series has actually MISSED — not how many days old its
 * newest observation is.
 *
 * These are different questions and conflating them is a real bug. A monthly
 * series is stamped with its REFERENCE month, and core PCE publishes about 30
 * days after that month ends, so a perfectly current core PCE is always 40-70
 * calendar days "old". Judging freshness on raw age therefore marks every
 * monthly series permanently stale and pins the panel's confidence to "low"
 * forever, which trains the reader to ignore the one field that is supposed to
 * tell them when something is genuinely wrong.
 *
 * Payrolls publish 5 days after month end and core PCE 30, so on 9 August
 * payrolls should have July and core PCE should only have June. Same calendar
 * age, different verdicts — hence the per-series `releaseLagDays`.
 */
function releasesBehind(latestDate, { frequency = 'monthly', releaseLagDays = 0, anchorDate = null } = {}) {
  if (!latestDate) return null;
  const anchor = new Date(`${(anchorDate || new Date().toISOString().slice(0, 10))}T00:00:00Z`);
  const latest = new Date(`${String(latestDate).slice(0, 10)}T00:00:00Z`);

  if (frequency === 'daily' || frequency === 'weekly') {
    const step = frequency === 'daily' ? 1 : 7;
    // Three days of slack absorbs a weekend plus a public holiday.
    const days = (anchor - latest) / DAY_MS - releaseLagDays - 3;
    return Math.max(0, Math.floor(days / step));
  }

  // The newest reference month that should have published by now.
  const publishable = new Date(anchor);
  publishable.setUTCDate(publishable.getUTCDate() - releaseLagDays);
  publishable.setUTCDate(1);
  publishable.setUTCMonth(publishable.getUTCMonth() - 1);

  const months = (publishable.getUTCFullYear() - latest.getUTCFullYear()) * 12
    + (publishable.getUTCMonth() - latest.getUTCMonth());
  return Math.max(0, months);
}

module.exports = {
  TRANSFORMS, TOLERANCE_DAYS,
  parseFredValue, sixMonthsBefore, findClosest, findMonth,
  roc, changePp, annualizedRate, computeMetrics, releasesBehind,
};
