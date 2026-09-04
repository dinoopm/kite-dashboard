// ─── US picks scorecard — what was ACTUALLY recorded, scored against SPY ─────
//
// Same question picks/scorecard.js asks of the Indian picks: not "would the
// model have worked", which is the backtest's job, but "did the rows written to
// us_pick_snapshots that evening beat the index afterwards". No reconstruction.
//
// One thing India's scorer does not do: a per-factor information coefficient
// from the RECORDED percentiles. It is the only way EPS revisions — which has
// no vintage history and so no backtest — can ever be scored, and it is the
// reason the snapshot stores every factor's percentile rather than just the
// composite. Weak, because it is measured inside the top 25 only (the
// percentiles are already all high), and stated as such.

const { createClient } = require('@supabase/supabase-js');
const { scoreSignal } = require('../signalScoring');
const { headline, present, MIN_N } = require('../signals/scorecard');
const { buildUsMarketContext, BENCHMARK } = require('../signals/usMarketSeries');
const { signalMeta } = require('../signals/registry');

const HORIZONS = [5, 10, 22];
const FACTOR_COLS = { momentum: 'momentum_pct', volume: 'volume_pct', fiftyTwo: 'fifty_two_pct', relStrength: 'rel_strength_pct', revisions: 'revisions_pct' };

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY) : null;

async function defaultFetch() {
  if (!supabase) throw new Error('Supabase not configured');
  const PAGE = 1000;
  let offset = 0;
  const out = [];
  for (;;) {
    const { data, error } = await supabase.from('us_pick_snapshots')
      .select('snap_date,symbol,rank,momentum_pct,volume_pct,fifty_two_pct,rel_strength_pct,revisions_pct')
      .order('snap_date', { ascending: true }).order('rank', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`us_pick_snapshots: ${error.message}`);
    out.push(...(data || []).map(r => ({ ...r, date: r.snap_date })));
    if (!data || data.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

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
function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const rx = midRanks(xs), ry = midRanks(ys);
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

/** Per-factor Spearman IC of recorded percentiles vs forward return, per snapshot day. */
function factorICFromRows(rows, seriesBySymbol, horizon) {
  const byDate = new Map();
  for (const r of rows) { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push(r); }
  const samples = Object.fromEntries(Object.keys(FACTOR_COLS).map(k => [k, []]));
  for (const [date, dayRows] of byDate) {
    const rets = [], per = Object.fromEntries(Object.keys(FACTOR_COLS).map(k => [k, []]));
    for (const r of dayRows) {
      const s = seriesBySymbol[r.symbol];
      const i = s ? s.findIndex(b => b.date === date) : -1;
      if (i < 0 || i + horizon >= s.length) continue;
      const c0 = s[i].close, c1 = s[i + horizon].close;
      if (!(c0 > 0) || c1 == null) continue;
      rets.push(c1 / c0 - 1);
      for (const k of Object.keys(FACTOR_COLS)) per[k].push(r[FACTOR_COLS[k]] ?? 50);
    }
    if (rets.length < 3) continue;
    for (const k of Object.keys(FACTOR_COLS)) { const ic = spearman(per[k], rets); if (ic != null) samples[k].push(ic); }
  }
  const out = {};
  for (const k of Object.keys(FACTOR_COLS)) {
    const a = samples[k];
    const m = a.length ? mean(a) : null;
    const sd = a.length > 1 ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)) : null;
    out[k] = { meanIC: m == null ? null : +m.toFixed(3), tStat: m != null && sd ? +(m / (sd / Math.sqrt(a.length))).toFixed(2) : null, dates: a.length };
  }
  return out;
}

const badge = (name, rowsPresented, emissions, { source = 'recorded' } = {}) => {
  const meta = signalMeta(name);
  const dates = [...new Set(emissions.map(e => e.date))];
  return {
    signal: name, label: meta?.label || name, description: meta?.description || null, source, market: 'US',
    firings: emissions.length, symbols: new Set(emissions.map(e => e.symbol)).size,
    firstFired: dates[0] || null, lastFired: dates[dates.length - 1] || null,
    horizons: rowsPresented,
    headline: emissions.length ? headline(rowsPresented, { source, benchmarkLabel: BENCHMARK }) : { state: 'no-data', text: 'No snapshots recorded yet', detail: 'The track record starts accumulating from the first daily snapshot.' },
  };
};

async function runUsPicksScorecard({ fetchRows = defaultFetch, context = buildUsMarketContext } = {}) {
  const rows = await fetchRows();
  if (!rows.length) {
    return {
      params: { horizons: HORIZONS, benchmark: BENCHMARK, minN: MIN_N },
      period: null, overall: [], top10: [], factorIC: null,
      signals: [badge('us_picks_top25', [], []), badge('us_picks_top10', [], [])],
      caveats: ['No snapshots recorded yet — the track record starts accumulating from the first daily snapshot.'],
      generatedAt: new Date().toISOString(),
    };
  }
  const firstDate = rows[0].date;
  const symbols = [...new Set(rows.map(r => r.symbol))];
  const ctx = await context(symbols, firstDate);
  const opts = { horizons: HORIZONS, benchmark: ctx.benchmark };
  const overall = present(scoreSignal(rows, ctx.seriesBySymbol, opts));
  const top10Rows = rows.filter(r => r.rank <= 10);
  const top10 = present(scoreSignal(top10Rows, ctx.seriesBySymbol, opts));
  const dates = [...new Set(rows.map(r => r.date))];
  return {
    params: { horizons: HORIZONS, benchmark: BENCHMARK, minN: MIN_N, topSlice: 10 },
    period: { first: firstDate, last: dates[dates.length - 1], snapshotDays: dates.length, emissions: rows.length },
    calendarGaps: ctx.calendarGaps,
    overall, top10,
    factorIC: factorICFromRows(rows, ctx.seriesBySymbol, 10),
    signals: [badge('us_picks_top25', overall, rows), badge('us_picks_top10', top10, top10Rows)],
    caveats: [
      'Only picks actually written to us_pick_snapshots — no reconstruction, no lookahead.',
      'Emissions overlap heavily day to day (a pick usually stays in the top 25), so n overstates the independent evidence.',
      'Entry at the snapshot-date close; costs and slippage are not modeled.',
      'Excess is over SPY; the backtest measures excess over the universe median as well.',
      'Factor IC is measured inside the recorded top 25 only, where every percentile is already high — a weak test, and the only one EPS revisions can ever get.',
      'Recent snapshots have not had time to resolve at the longer horizons; they are counted in `unresolved`, never as flat.',
    ],
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runUsPicksScorecard, factorICFromRows, HORIZONS };
