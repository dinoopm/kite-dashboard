// ─── Picks forward-return validation ─────────────────────────────────────────
// Reconstructs the deterministic picks for past dates (same engine, default
// weights, traps excluded) and measures what happened next, using nse_bhavcopy
// universe-wide closes:
//   - top-N forward return vs the universe median (the fair benchmark for a
//     stock screen: did the picks beat the average stock?)
//   - hit rate, composite-quintile monotonicity
//   - per-factor information coefficient (Spearman rank corr vs forward return)
// Entry is the eval-date close; costs/slippage are not modeled. The surveillance
// exclusion uses the CURRENT ASM/GSM list (small lookahead — the table isn't dated).
//
// Horizons are counted in BARS, so the calendar has to be right. nse_bhavcopy
// has ingested holes (2026-07-03/06/07 were missing while NIFTY traded), and on
// the bhavcopy-only calendar those holes close up: 07-02 and 07-08 look
// adjacent, so a "5-day" return silently spans seven real sessions and the
// excess/IC numbers are computed over windows that aren't the length they claim.
// The fix is the one picks/scorecard.js already uses — merge the index's own
// sessions in via signals/marketSeries, which restores spacing at no cost, and
// report the holes as `calendarGaps` rather than absorbing them.

const { buildFactorUniverse, rankUniverse } = require('./engine');
const {
  fetchAll, fetchTradingDates, fetchBenchmark,
  mergeCalendars, findCalendarGaps, BENCHMARK,
} = require('../signals/marketSeries');

// Factor feeds only reach full coverage from mid-May 2026 (volume_gainers
// 2026-05-04, nse_52_week_high_low 2026-05-14) — evaluating earlier would rank
// on partial data the live model never sees.
const EVAL_FLOOR = '2026-05-18';
const LOOKBACK_DAYS = 30; // calendar, mirrors the live default period

// date -> (symbol -> close), EQ preferred over BE. Dates the table never
// ingested come back as empty maps, which is what makes a window ending on a
// gap drop out of the sample instead of being scored against a stale price.
async function getCloses(dates) {
  const map = new Map(dates.map(d => [d, new Map()]));
  const CHUNK = 10; // .in() filter on a manageable number of dates per query
  for (let i = 0; i < dates.length; i += CHUNK) {
    const rows = await fetchAll('nse_bhavcopy', 'trade_date,symbol,series,close',
      (q) => q.in('trade_date', dates.slice(i, i + CHUNK)));
    for (const r of rows) {
      if (r.close == null) continue;
      const m = map.get(r.trade_date);
      if (!m.has(r.symbol) || r.series === 'EQ') m.set(r.symbol, r.close);
    }
  }
  return map;
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

function midRanks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = r;
    i = j + 1;
  }
  return ranks;
}

// Spearman rank correlation (mid-rank ties).
function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const rx = midRanks(xs), ry = midRanks(ys);
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

const isoMinus = (iso, days) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

const FACTOR_KEYS = ['momentum', 'volume', 'fiftyTwo', 'deals'];

/**
 * Entry dates: every `step` bars along `calendar` from `floor` on, keeping room
 * for the shortest horizon.
 *
 * Both the stepping and the room check run on the MERGED calendar, so a session
 * bhavcopy is missing still consumes a bar — that is the whole point, since a
 * bar is what a horizon is counted in. A gap date can never be an entry itself
 * (`priceDates` gates that): with no closes there is nothing to rank or buy,
 * and pretending otherwise would enter the next available price under an
 * earlier date's label.
 */
function pickEvalDates(calendar, priceDates, { step, minHorizon, floor }) {
  const priced = new Set(priceDates);
  const out = [];
  for (let i = 0; i < calendar.length; i += step) {
    const d = calendar[i];
    if (d >= floor && priced.has(d) && i + minHorizon < calendar.length) out.push(d);
  }
  return out;
}

async function runBacktest({ horizons = [5, 10, 20], step = 5, topN = 25 } = {}) {
  // Bhavcopy's own sessions, plus the ones only the index knows about. A
  // missing benchmark degrades to the bhavcopy calendar rather than failing —
  // Yahoo being down should not delete the backtest, only its gap detection.
  const bhavDates = await fetchTradingDates();
  if (!bhavDates.length) throw new Error('No evaluable dates yet — feeds/bhavcopy history too short.');
  const benchByDate = await fetchBenchmark(bhavDates[0]).catch(() => null);

  const tdates = mergeCalendars(bhavDates, benchByDate ? [...benchByDate.keys()] : [], bhavDates[0]);
  const calendarGaps = findCalendarGaps(bhavDates, tdates);
  const dateIdx = new Map(tdates.map((d, i) => [d, i]));
  const maxH = Math.min(...horizons);

  const evalDates = pickEvalDates(tdates, bhavDates, { step, minHorizon: maxH, floor: EVAL_FLOOR });
  if (!evalDates.length) throw new Error('No evaluable dates yet — feeds/bhavcopy history too short.');

  // All dates whose closes we need (entries + exits).
  const needed = new Set();
  for (const d of evalDates) {
    needed.add(d);
    for (const h of horizons) {
      const j = dateIdx.get(d) + h;
      if (j < tdates.length) needed.add(tdates[j]);
    }
  }
  const closes = await getCloses([...needed].sort());

  const perDate = [];   // detail rows for the UI
  const icSamples = Object.fromEntries([...FACTOR_KEYS, 'composite'].map(k => [k, []]));
  const excessSamples = {}; // horizon -> [excess per eval date]
  const hitCounts = {};     // horizon -> { hits, total }
  const quintiles = {};     // horizon -> [[q1 rets], ..., [q5 rets]] pooled

  for (const D of evalDates) {
    const universe = await buildFactorUniverse({ from: isoMinus(D, LOOKBACK_DAYS), to: D });
    const ranked = rankUniverse(universe.stocks); // default weights, traps excluded
    const entry = closes.get(D);
    const detail = { evalDate: D, universe: ranked.length, horizons: {} };

    for (const h of horizons) {
      const j = dateIdx.get(D) + h;
      if (j >= tdates.length) continue;
      const exit = closes.get(tdates[j]);

      const rows = []; // { rank, composite, pct, ret }
      for (const s of ranked) {
        const e0 = entry.get(s.symbol), e1 = exit.get(s.symbol);
        if (e0 == null || e1 == null || e0 <= 0) continue;
        rows.push({ rank: s.rank, composite: s.composite, pct: s.pct, ret: e1 / e0 - 1 });
      }
      if (rows.length < 50) continue; // too thin to score

      const uniMedian = median(rows.map(r => r.ret));
      const topRows = rows.filter(r => r.rank <= topN);
      if (!topRows.length) continue;
      const topMean = mean(topRows.map(r => r.ret));
      const hits = topRows.filter(r => r.ret > uniMedian).length;

      // Composite quintiles (rank order, pooled across eval dates)
      const sorted = [...rows].sort((a, b) => a.rank - b.rank);
      const qsize = Math.floor(sorted.length / 5) || 1;
      quintiles[h] = quintiles[h] || [[], [], [], [], []];
      sorted.forEach((r, k) => quintiles[h][Math.min(4, Math.floor(k / qsize))].push(r.ret));

      // ICs on the 10d (middle) horizon only, to avoid triple-counting overlap
      if (h === horizons[Math.floor(horizons.length / 2)]) {
        for (const f of FACTOR_KEYS) {
          const ic = spearman(rows.map(r => r.pct[f]), rows.map(r => r.ret));
          if (ic != null) icSamples[f].push(ic);
        }
        const icC = spearman(rows.map(r => r.composite), rows.map(r => r.ret));
        if (icC != null) icSamples.composite.push(icC);
      }

      (excessSamples[h] = excessSamples[h] || []).push(topMean - uniMedian);
      hitCounts[h] = hitCounts[h] || { hits: 0, total: 0 };
      hitCounts[h].hits += hits;
      hitCounts[h].total += topRows.length;

      detail.horizons[h] = {
        topMean: +(topMean * 100).toFixed(2),
        uniMedian: +(uniMedian * 100).toFixed(2),
        excess: +((topMean - uniMedian) * 100).toFixed(2),
        picks: topRows.length,
        scored: rows.length,
      };
    }
    perDate.push(detail);
  }

  const summary = horizons.map(h => {
    const ex = excessSamples[h] || [];
    const hc = hitCounts[h] || { hits: 0, total: 0 };
    const qs = (quintiles[h] || []).map(q => (q.length ? +(mean(q) * 100).toFixed(2) : null));
    return {
      horizon: h,
      evalDates: ex.length,
      meanExcessPct: ex.length ? +(mean(ex) * 100).toFixed(2) : null,
      hitRatePct: hc.total ? +((hc.hits / hc.total) * 100).toFixed(1) : null,
      pickObs: hc.total,
      quintileMeansPct: qs, // Q1 (top) … Q5 (bottom)
    };
  });

  const ics = [...FACTOR_KEYS, 'composite'].map(f => {
    const arr = icSamples[f];
    const m = arr.length ? mean(arr) : null;
    const sd = arr.length > 1 ? Math.sqrt(mean(arr.map(v => (v - m) ** 2)) * arr.length / (arr.length - 1)) : null;
    return {
      factor: f,
      meanIC: m != null ? +m.toFixed(3) : null,
      tStat: m != null && sd ? +((m / (sd / Math.sqrt(arr.length)))).toFixed(2) : null,
      dates: arr.length,
    };
  });

  return {
    params: { horizons, step, topN, lookbackDays: LOOKBACK_DAYS, evalFloor: EVAL_FLOOR },
    period: { firstEval: evalDates[0], lastEval: evalDates[evalDates.length - 1], evalDates: evalDates.length },
    calendarGaps,
    summary, ics, perDate,
    caveats: [
      ...(calendarGaps.length
        ? [`nse_bhavcopy is missing ${calendarGaps.length} session(s) the index traded (${calendarGaps.join(', ')}). Horizons are counted on the merged calendar so bar spacing stays right, but a window entering or exiting on those dates has no price and drops out of the sample.`]
        : []),
      // ^NSEI is only the reference CALENDAR here — the return benchmark stays
      // the universe median (next caveat). Without it a bhavcopy hole is
      // invisible, which is worth saying rather than quietly reverting to the
      // stretched-horizon behaviour this file used to have.
      ...(benchByDate ? [] : [`Index calendar (${BENCHMARK}) unavailable, so sessions are bhavcopy's alone — any session it skipped is undetectable here and horizons spanning one are stretched.`]),
      'Short history — treat as preliminary; error bars are wide.',
      'Benchmark = universe median return (did picks beat the average active stock).',
      'Entry at eval-date close; transaction costs, slippage and liquidity not modeled.',
      'Surveillance exclusion uses the current ASM/GSM list (minor lookahead).',
    ],
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runBacktest, pickEvalDates };
