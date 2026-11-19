// ─── RRG series, as a pure function ──────────────────────────────────────────
//
// The Relative Rotation Graph the app draws is computed inline in two route
// handlers (GET /api/us/rrg and the Indian /api/rrg), which return only the
// last 52 weekly points. Scoring whether rotation predicts anything needs the
// whole series and needs it without a request, so the same arithmetic lives
// here as a function of two daily-bar arrays:
//
//   raw RS      = sector close / benchmark close × 100, weekly (last close of
//                 the week, keyed by that week's Friday)
//   smoothed RS = 10-week EMA of raw RS
//   RS-Ratio    = smoothed RS / its own 52-week SMA × 100
//   RS-Momentum = RS-Ratio / its own 26-week SMA × 100
//   (26 and 13 instead of 52 and 26 when fewer than 52 aligned weeks exist)
//
// Every value at week t uses only weeks ≤ t, so a series rebuilt today places
// each past week where the chart placed it then, once the EMA's seed has
// washed out — which it has long before the first point exists, since a point
// needs 77 weeks behind it.
//
// This is now the ONLY copy. GET /api/us/rrg (alpaca.js) and the Indian
// /api/rrg (server.js) both call rrgSeries, so the chart and the rotation
// track record cannot describe different points. Before 2026-11-19 each route
// had its own inline copy; switching was checked to be output-identical — the
// US route byte-for-byte on all 29 sectors × 52 weeks, the Indian maths on
// synthetic Kite-style data — except that the old Indian copy keyed weeks in
// the server's local timezone (see the IST test in rrg/series.test.js).

const EMA_WEEKS = 10;

/** The Friday (UTC) of the week a date falls in, as YYYY-MM-DD. */
function fridayKey(date) {
  const d = new Date(date);
  const f = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  f.setUTCDate(f.getUTCDate() + (5 - f.getUTCDay()));
  return f.toISOString().slice(0, 10);
}

/**
 * Daily bars → weekly, one row per week that traded: the last close, and the
 * low and high across the week (the low is what the adverse-move measurement
 * in signalScoring reads).
 */
function resampleToWeekly(daily) {
  const weeks = [];
  let cur = null;
  for (const c of daily || []) {
    if (!Number.isFinite(c?.close)) continue;
    const key = fridayKey(c.date);
    if (!cur || cur.date !== key) {
      cur = { date: key, close: c.close, low: c.low ?? c.close, high: c.high ?? c.close, lastBar: String(c.date).slice(0, 10) };
      weeks.push(cur);
    } else {
      cur.close = c.close;
      cur.lastBar = String(c.date).slice(0, 10);
      if (Number.isFinite(c.low)) cur.low = Math.min(cur.low, c.low);
      if (Number.isFinite(c.high)) cur.high = Math.max(cur.high, c.high);
    }
  }
  return weeks;
}

function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

function sma(values, period) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out.push(sum / period);
  }
  return out;
}

const r2 = (v) => parseFloat(v.toFixed(2));

/**
 * The full weekly RRG series for one sector against one benchmark.
 * Returns [] when there is too little shared history to place a single point.
 * Each point: { date (Friday), rsRatio, rsMomentum }.
 */
function rrgSeries(sectorDaily, benchDaily) {
  const bench = new Map(resampleToWeekly(benchDaily).map(w => [w.date, w.close]));
  const aligned = resampleToWeekly(sectorDaily)
    .filter(w => bench.get(w.date) > 0)
    .map(w => ({ date: w.date, raw: (w.close / bench.get(w.date)) * 100 }));
  if (aligned.length < 26) return [];

  const ratioWindow = aligned.length >= 52 ? 52 : 26;
  const momWindow = aligned.length >= 52 ? 26 : 13;
  const smooth = ema(aligned.map(a => a.raw), EMA_WEEKS);
  const smoothSma = sma(smooth, ratioWindow);
  const ratio = smooth.map((v, i) => (smoothSma[i] == null || smoothSma[i] === 0 ? null : (v / smoothSma[i]) * 100));

  const first = ratio.findIndex(v => v !== null && v !== 0);
  if (first < 0) return [];
  const valid = ratio.slice(first);
  const validSma = sma(valid, momWindow);

  const out = [];
  for (let i = 0; i < valid.length; i++) {
    const v = valid[i], avg = validSma[i];
    if (v == null || v === 0 || avg == null || avg === 0) continue;
    out.push({ date: aligned[first + i].date, rsRatio: r2(v), rsMomentum: r2((v / avg) * 100) });
  }
  return out;
}

/** Same boundaries as the routes and the frontend: 100 counts as the strong side. */
function quadrantOf(rsRatio, rsMomentum) {
  if (rsRatio >= 100) return rsMomentum >= 100 ? 'Leading' : 'Weakening';
  return rsMomentum >= 100 ? 'Improving' : 'Lagging';
}

/**
 * Has the week ending on this Friday finished trading? The routes include the
 * week in progress as the chart's last point; a track record must not, because
 * a quadrant read off Tuesday's close is not that week's quadrant. 16:15 in
 * New York on the Friday itself, or any later date.
 */
function weekComplete(friday, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(x => [x.type, x.value]));
  const today = `${p.year}-${p.month}-${p.day}`;
  if (friday < today) return true;
  if (friday > today) return false;
  return +p.hour * 60 + +p.minute >= 16 * 60 + 15;
}

module.exports = { rrgSeries, resampleToWeekly, quadrantOf, weekComplete, fridayKey, ema, sma, EMA_WEEKS };
