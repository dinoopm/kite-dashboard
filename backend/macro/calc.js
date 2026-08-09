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
    rocPct: null, changePp: null, annualized3m: null, annualized6m: null,
    yoyPct: null, avg3mChange: null, lastChange: null, observations: rows.length,
  };
  if (!rows.length) return empty;

  const last = rows[rows.length - 1];
  const anchor = anchorDate ? String(anchorDate).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const ageDays = Math.round((Date.parse(`${anchor}T00:00:00Z`) - Date.parse(`${last.observation_date}T00:00:00Z`)) / DAY_MS);

  // Windows are measured back from the LATEST OBSERVATION, not from today.
  // Anchoring on today would shorten the window by the release lag — core PCE
  // publishes about a month late, so "six months back from today" is seven
  // months of data for that series and six for oil.
  const back = (m) => {
    const d = new Date(`${last.observation_date}T00:00:00Z`);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - m);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
    return findClosest(rows, d.toISOString().slice(0, 10), tol);
  };

  const six = findClosest(rows, sixMonthsBefore(last.observation_date), tol);
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
    out.rocPct = six ? roc(last.value, six.value) : null;   // display only
  } else if (transform === 'price') {
    out.rocPct = six ? roc(last.value, six.value) : null;
  } else if (transform === 'rate') {
    out.changePp = six ? changePp(last.value, six.value) : null;
  } else if (transform === 'count') {
    const prev = rows.length >= 2 ? rows[rows.length - 2] : null;
    out.lastChange = prev ? last.value - prev.value : null;
    const threeBack = rows.length >= 4 ? rows[rows.length - 4] : null;
    out.avg3mChange = threeBack ? (last.value - threeBack.value) / 3 : null;
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
  parseFredValue, sixMonthsBefore, findClosest,
  roc, changePp, annualizedRate, computeMetrics, releasesBehind,
};
