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

const { createClient } = require('@supabase/supabase-js');
const { buildFactorUniverse, rankUniverse } = require('./engine');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Factor feeds only reach full coverage from mid-May 2026 (volume_gainers
// 2026-05-04, nse_52_week_high_low 2026-05-14) — evaluating earlier would rank
// on partial data the live model never sees.
const EVAL_FLOOR = '2026-05-18';
const LOOKBACK_DAYS = 30; // calendar, mirrors the live default period

async function fetchAll(table, cols, applyFilters) {
  const PAGE = 1000;
  let offset = 0;
  const out = [];
  for (;;) {
    let q = supabase.from(table).select(cols).range(offset, offset + PAGE - 1);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

// Trading calendar = RELIANCE's bhavcopy dates (trades every session).
async function getTradingDates() {
  const rows = await fetchAll('nse_bhavcopy', 'trade_date',
    (q) => q.eq('symbol', 'RELIANCE').eq('series', 'EQ').order('trade_date', { ascending: true }));
  return rows.map(r => r.trade_date);
}

// date -> (symbol -> close), EQ preferred over BE.
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

async function runBacktest({ horizons = [5, 10, 20], step = 5, topN = 25 } = {}) {
  const tdates = await getTradingDates();
  const dateIdx = new Map(tdates.map((d, i) => [d, i]));
  const maxH = Math.min(...horizons);

  // Eval dates: every `step` sessions from the feed floor, keeping room for at
  // least the shortest horizon.
  const evalDates = [];
  for (let i = 0; i < tdates.length; i += step) {
    const d = tdates[i];
    if (d >= EVAL_FLOOR && i + maxH < tdates.length) evalDates.push(d);
  }
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
    summary, ics, perDate,
    caveats: [
      'Short history — treat as preliminary; error bars are wide.',
      'Benchmark = universe median return (did picks beat the average active stock).',
      'Entry at eval-date close; transaction costs, slippage and liquidity not modeled.',
      'Surveillance exclusion uses the current ASM/GSM list (minor lookahead).',
    ],
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runBacktest };
