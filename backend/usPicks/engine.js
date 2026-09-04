// ─── US Quant Picks engine ───────────────────────────────────────────────────
//
// The Indian engine (picks/engine.js) with the parts this market can supply.
// Same shape on purpose: raw factors per stock from the server, percentile
// ranking and weights on the client so sliders re-rank instantly, and ONE
// deterministic default-weight series written to the snapshot table every
// session — that series is the track record, and nothing a user does with the
// sliders touches it.
//
// Two layers, kept apart so the backtest can use the second without the first:
//
//   loadInputs()        fetches — bars for the whole universe in a handful of
//                       multi-symbol calls, membership, earnings dates, EPS
//                       revisions, the macro label.
//   buildUniverseFrom() computes — factor rows, exclusions, regime — from those
//                       inputs at an `asOf` date. Pure. Runs at any past date
//                       on the same bars, which is what makes the backtest an
//                       evaluation of THIS code rather than a copy of it.

const { createClient } = require('@supabase/supabase-js');
const { fetchBarsMulti } = require('../alpacaData');
const { barFlags } = require('../usRedFlags');
const { getSP500, getNasdaq100 } = require('../usUniverses');
const { fetchRevisions } = require('./revisions');
const F = require('./factors');

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

const BENCHMARK = 'SPY';
const ILLIQUID_FLOOR = 10e6;   // median $ volume / day — the ₹1cr floor's analogue
const EARNINGS_WINDOW = 5;     // sessions; a report inside it is a coin flip, not a factor bet
const LIVE_MONTHS = 15;        // 252 for the 52-week window + 63 for RS + holidays

const DEFAULT_WEIGHTS = { momentum: 30, volume: 20, fiftyTwo: 15, relStrength: 20, revisions: 15 };
// The backtest cannot see historical estimate revisions, so it scores the four
// price factors and SAYS so. Not a different model — the same one with one
// input unavailable.
const BACKTEST_WEIGHTS = { ...DEFAULT_WEIGHTS, revisions: 0 };
const FACTOR_RAW = { momentum: 'momentumRaw', volume: 'volumeRaw', fiftyTwo: 'fiftyTwoRaw', relStrength: 'relStrengthRaw', revisions: 'revisionsRaw' };

const round = (v, p = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(p));
const isoDay = (d) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** S&P 500 ∪ Nasdaq 100, one row per symbol, GICS sector where the scrape has it. */
async function loadMembers() {
  const [sp, ndx] = await Promise.all([getSP500().catch(() => []), getNasdaq100().catch(() => [])]);
  const out = new Map();
  for (const m of sp) out.set(m.symbol, { symbol: m.symbol, name: m.name || m.symbol, sector: m.sector || null });
  for (const m of ndx) if (!out.has(m.symbol)) out.set(m.symbol, { symbol: m.symbol, name: m.name || m.symbol, sector: m.sector || null });
  return [...out.values()];
}

/** symbol -> next earnings date (ISO), from the cached calendar. */
async function loadEarnings() {
  // Required lazily: alpaca.js is the router and pulls in everything.
  const { getEarningsCalendar } = require('../alpaca');
  const cal = await getEarningsCalendar().catch(() => ({ events: [] }));
  const m = new Map();
  for (const e of cal.events || []) if (!m.has(e.symbol)) m.set(e.symbol, e.date);
  return m;
}

/** The latest recorded macro regime label, or null when the table is absent. */
async function loadMacroLabel() {
  if (!supabase) return null;
  const { data, error } = await supabase.from('macro_signal_snapshots')
    .select('regime').order('snap_date', { ascending: false }).limit(1);
  if (error) return null;
  return data?.[0]?.regime || null;
}

const normaliseBars = (arr) => (arr || [])
  .map(b => ({ ...b, date: isoDay(b.date) }))
  .sort((a, b) => a.date.localeCompare(b.date));

async function loadInputs({ from = null, includeRevisions = true, includeEarnings = true } = {}) {
  const members = await loadMembers();
  const symbols = members.map(m => m.symbol);
  const start = from ? new Date(from) : (() => { const d = new Date(); d.setMonth(d.getMonth() - LIVE_MONTHS); return d; })();
  const [raw, earningsBySymbol, revisions, macroLabel] = await Promise.all([
    fetchBarsMulti([...symbols, BENCHMARK], start),
    includeEarnings ? loadEarnings() : new Map(),
    includeRevisions ? fetchRevisions(symbols) : { bySymbol: new Map(), missing: 0, failed: 0 },
    loadMacroLabel(),
  ]);
  const barsBySymbol = {};
  for (const s of symbols) if (raw[s]?.length) barsBySymbol[s] = normaliseBars(raw[s]);
  return {
    members, barsBySymbol, spyBars: normaliseBars(raw[BENCHMARK]),
    earningsBySymbol, revisionsBySymbol: revisions.bySymbol, revisionsMissing: revisions.missing,
    revisionsFailed: revisions.failed, macroLabel,
  };
}

// ─── Universe ────────────────────────────────────────────────────────────────

/** Index of the last bar with date ≤ asOf, or -1. */
function indexAsOf(bars, asOf) {
  if (!asOf) return bars.length - 1;
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].date <= asOf) lo = mid + 1; else hi = mid; }
  return lo - 1;
}

/**
 * Approximate trading sessions strictly after fromDate, up to and including
 * toDate. An earnings date is always beyond the historical bars we hold (we
 * only fetch price history up to today), so this can't look up the real SPY
 * calendar the way `indexAsOf` does — it counts weekdays instead. Worst case
 * a market holiday is off by one session, which doesn't matter at the
 * 5-session gate this feeds.
 */
function sessionsUntil(fromDate, toDate) {
  const from = new Date(`${fromDate}T00:00:00Z`).getTime();
  const to = new Date(`${toDate}T00:00:00Z`).getTime();
  let n = 0;
  for (let t = from + 86400000; t <= to; t += 86400000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}

function buildUniverseFrom(inputs, { asOf = null, momentum = {} } = {}) {
  const { members, barsBySymbol, spyBars, earningsBySymbol, revisionsBySymbol, revisionsMissing, revisionsFailed, macroLabel } = inputs;
  const spyIdx = indexAsOf(spyBars, asOf);
  if (spyIdx < 0) throw new Error('No SPY bars on or before asOf');
  const snapshotDate = spyBars[spyIdx].date;
  // SPY closes keyed by date so a symbol missing a session still aligns.
  const spyByDate = new Map(spyBars.map(b => [b.date, b.close]));

  const stocks = [];
  let excludedCount = 0;
  const excludedSample = [];
  const exclude = (sym, why) => { excludedCount++; if (excludedSample.length < 8) excludedSample.push(`${sym} (${why})`); };

  for (const m of members) {
    const bars = barsBySymbol[m.symbol];
    if (!bars?.length) continue;
    const i = indexAsOf(bars, snapshotDate);
    if (i < 0) continue;
    const upTo = bars.slice(0, i + 1);
    const closes = upTo.map(b => b.close);
    const volumes = upTo.map(b => b.volume);
    const spyCloses = upTo.map(b => spyByDate.get(b.date) ?? null);

    const f = F.factorRowAt({ closes, volumes, spyCloses }, i, { momentum });
    if (f.momentumRaw == null) continue; // not enough history to rank at all

    if (f.dollarVolume != null && f.dollarVolume < ILLIQUID_FLOOR) { exclude(m.symbol, `illiquid: $${(f.dollarVolume / 1e6).toFixed(1)}M/day`); continue; }
    const earningsDate = earningsBySymbol.get(m.symbol) || null;
    if (earningsDate && earningsDate >= snapshotDate && sessionsUntil(snapshotDate, earningsDate) <= EARNINGS_WINDOW) {
      exclude(m.symbol, `earnings ${earningsDate}`); continue;
    }
    const flags = F.dollarVolumeMedianAt(closes, volumes, i) == null ? [] : barFlags(upTo.slice(-60));
    if (flags.some(x => x.severity === 'red')) { exclude(m.symbol, flags.find(x => x.severity === 'red').id); continue; }

    const revisionsRaw = revisionsBySymbol.has(m.symbol) ? revisionsBySymbol.get(m.symbol) : null;
    stocks.push({
      symbol: m.symbol, name: m.name, sector: m.sector,
      lastClose: round(closes[i]),
      earningsDate,
      flags: flags.map(x => ({ id: x.id, severity: x.severity, title: x.title })),
      factors: {
        momentumRaw: round(f.momentumRaw, 4),
        volumeRaw: round(f.volumeRaw, 3), surgePct: round(f.surgePct, 0), authenticity: f.authenticity == null ? null : round(f.authenticity * 100, 0),
        trapRisk: f.trapRisk, trapReason: f.trapReason,
        fiftyTwoRaw: round(f.fiftyTwoRaw, 3), nearHighPct: round(f.nearHighPct, 3), newHigh5: f.newHigh5, newLow5: f.newLow5,
        relStrengthRaw: round(f.relStrengthRaw, 2),
        revisionsRaw: revisionsRaw == null ? null : round(revisionsRaw, 3),
        dollarVolume: round(f.dollarVolume, 0),
        aboveSma50: f.aboveSma50, aboveSma200: f.aboveSma200,
      },
    });
  }

  const b = F.breadth(stocks.map(s => ({ aboveSma50: s.factors.aboveSma50, aboveSma200: s.factors.aboveSma200, momentumRaw: s.factors.momentumRaw })));
  const regime = {
    breadth: b, macro: macroLabel,
    label: `Breadth ${b.label} (${b.pctAbove50 ?? '—'}% > 50D, ${b.pctAbove200 ?? '—'}% > 200D)${macroLabel ? ` · macro ${macroLabel}` : ''}`,
  };

  return {
    period: { asOf: asOf || snapshotDate, snapshotDate },
    regime,
    excludedCount, excludedSample,
    revisionsMissing: revisionsMissing ?? 0,
    revisionsFailed: revisionsFailed ?? 0,
    universeSize: stocks.length,
    generatedAt: new Date().toISOString(),
    stocks,
  };
}

async function buildUsFactorUniverse(opts = {}) {
  return buildUniverseFrom(await loadInputs(opts), opts);
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

/**
 * Mid-rank percentiles, 0–100. Ties share the middle of their block. `null`
 * means "no data" and lands at exactly 50 — the one place this differs from
 * India's `?? 0`, because a missing revision is not a bad revision.
 */
function percentileRanks(values) {
  const known = values.filter(v => v != null);
  const sorted = [...known].sort((a, b) => a - b);
  const n = sorted.length;
  return values.map(v => {
    if (v == null) return 50;
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    const first = lo;
    hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid + 1; else hi = mid; }
    return n ? ((first + lo) / 2 / n) * 100 : 50;
  });
}

function rankUniverse(stocks, weights = DEFAULT_WEIGHTS, { excludeTraps = true } = {}) {
  const pool = excludeTraps ? stocks.filter(s => !s.factors.trapRisk) : stocks;
  const keys = Object.keys(FACTOR_RAW);
  const cols = {};
  for (const k of keys) cols[k] = percentileRanks(pool.map(s => s.factors[FACTOR_RAW[k]]));
  const sumW = keys.reduce((a, k) => a + (weights[k] || 0), 0) || 1;
  return pool
    .map((s, i) => {
      const pct = {}; let composite = 0;
      for (const k of keys) { pct[k] = cols[k][i]; composite += ((weights[k] || 0) / sumW) * pct[k]; }
      return { ...s, pct, composite };
    })
    .sort((a, b) => b.composite - a.composite)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

// ─── Snapshots ───────────────────────────────────────────────────────────────

/** Persist the default-weight top 25 for one session. Table: migrate_us_pick_snapshots.js. */
async function saveDailySnapshot(universe) {
  if (!supabase) throw new Error('Supabase not configured');
  const snapDate = universe.period.snapshotDate;
  const top = rankUniverse(universe.stocks).slice(0, 25);
  if (!top.length) return { snapDate, saved: 0 };
  const rows = top.map(r => ({
    snap_date: snapDate, symbol: r.symbol, rank: r.rank,
    composite: +r.composite.toFixed(2),
    momentum_pct: +r.pct.momentum.toFixed(1), volume_pct: +r.pct.volume.toFixed(1),
    fifty_two_pct: +r.pct.fiftyTwo.toFixed(1), rel_strength_pct: +r.pct.relStrength.toFixed(1),
    revisions_pct: +r.pct.revisions.toFixed(1), revisions_raw: r.factors.revisionsRaw,
    trap_risk: !!r.factors.trapRisk, last_close: r.lastClose,
  }));
  const { error } = await supabase.from('us_pick_snapshots').upsert(rows, { onConflict: 'snap_date,symbol' });
  if (error) throw new Error(`us_pick_snapshots: ${error.message}`);
  return { snapDate, saved: rows.length };
}

async function fetchSnapshotHistory(sinceDate) {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from('us_pick_snapshots')
    .select('snap_date,symbol,rank,composite,trap_risk,last_close')
    .gte('snap_date', sinceDate)
    .order('snap_date', { ascending: false }).order('rank', { ascending: true }).limit(5000);
  if (error) throw new Error(`us_pick_snapshots: ${error.message}`);
  const byDate = new Map();
  for (const r of data || []) {
    if (!byDate.has(r.snap_date)) byDate.set(r.snap_date, []);
    byDate.get(r.snap_date).push({ symbol: r.symbol, rank: r.rank, composite: r.composite, trapRisk: r.trap_risk, lastClose: r.last_close });
  }
  return [...byDate.entries()].map(([date, picks]) => ({ date, picks }));
}

module.exports = {
  loadInputs, buildUniverseFrom, buildUsFactorUniverse, rankUniverse, percentileRanks,
  saveDailySnapshot, fetchSnapshotHistory, indexAsOf,
  DEFAULT_WEIGHTS, BACKTEST_WEIGHTS, FACTOR_RAW, BENCHMARK, ILLIQUID_FLOOR, EARNINGS_WINDOW,
};
