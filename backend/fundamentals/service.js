// ─── Reading the stored fundamentals back out ────────────────────────────────
//
// The seam between the database and aggregate.js, which is pure and knows about
// neither. Everything here is fetching, shaping and caching; every decision
// about what a number MEANS lives in the aggregator and is tested without a
// network.

const { createClient } = require('@supabase/supabase-js');
const { aggregateQuarter } = require('./aggregate');
const { issuerGroups } = require('./duplicates');
const { scopeSurprise, revisionBreadth } = require('./surprise');

const supabase = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// A per-quarter answer only changes when the ingest writes, which is once a
// night — so the cache is invalidated by the ingest rather than expiring on a
// timer. The TTL is a backstop for the CLI, which runs in a different process
// and cannot bump the counter.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let cacheVersion = 0;
const cache = new Map();

/** Called by dailyJobs after a successful ingest — see the TTL note above. */
function invalidateCache() { cacheVersion++; cache.clear(); }

function cached(key, build) {
  const hit = cache.get(key);
  if (hit && hit.version === cacheVersion && Date.now() - hit.ts < CACHE_TTL_MS) {
    return Promise.resolve(hit.value);
  }
  return Promise.resolve(build()).then(value => {
    cache.set(key, { value, ts: Date.now(), version: cacheVersion });
    return value;
  });
}

async function fetchAll(table, cols, applyFilters) {
  const PAGE = 1000;
  let offset = 0;
  const out = [];
  for (;;) {
    let q = supabase().from(table).select(cols).range(offset, offset + PAGE - 1);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

/** Stored rows → the camelCase shape aggregate.js expects. */
const toAggRow = (r) => ({
  market: r.market, symbol: r.symbol, periodType: r.period_type, periodEnd: r.period_end,
  label: r.label, eps: r.eps, netProfit: r.net_profit, revenue: r.revenue,
  operatingProfit: r.operating_profit, opm: r.opm, otherIncome: r.other_income,
  interest: r.interest, depreciation: r.depreciation, provisions: r.provisions,
  pbt: r.pbt, taxPct: r.tax_pct, isFinancial: r.is_financial,
  unit: r.unit, basis: r.basis, backfilled: r.backfilled, firstSeenAt: r.first_seen_at,
});

const loadRows = (market) => fetchAll('stock_fundamentals', '*', q => q.eq('market', market));

/** Constituents by scope key. India reads the table; the US reads its indices. */
async function loadScopes(market) {
  if (market === 'IN') {
    const rows = await fetchAll('sector_constituents', 'sector_key,symbol,name');
    const byScope = new Map();
    for (const r of rows) {
      if (!byScope.has(r.sector_key)) byScope.set(r.sector_key, []);
      byScope.get(r.sector_key).push({ symbol: r.symbol, name: r.name });
    }
    return byScope;
  }
  const { getSP500, getNasdaq100 } = require('../usUniverses');
  const [spx, ndx] = await Promise.all([getSP500(), getNasdaq100()]);
  return new Map([
    ['SP500', spx.map(r => ({ symbol: r.symbol, name: r.name, sector: r.sector }))],
    ['NASDAQ100', ndx.map(r => ({ symbol: r.symbol, name: r.name }))],
  ]);
}

/**
 * The most recent market-cap vector, and the day it was taken.
 *
 * ONE vector is returned, not one per period, because the weighted ratio must
 * apply the same weights to both sides — mixing vintages would blend earnings
 * change with weight drift and stop it being a cross-check on pool growth.
 */
async function loadConsensus(market) {
  const rows = await fetchAll('consensus_snapshots',
    'symbol,snap_date,trend_period,trend_end_date,eps_avg,analysts,market_cap',
    q => q.eq('market', market).order('snap_date', { ascending: false }));

  // Weights: ONE vector, from the newest day that has caps. The weighted ratio
  // must apply the same weights to both sides, so mixing vintages would blend
  // earnings change with weight drift.
  const withCap = rows.filter(r => r.market_cap != null);
  const asOf = withCap[0]?.snap_date || null;
  const weights = asOf
    ? Object.fromEntries(withCap.filter(r => r.snap_date === asOf).map(r => [r.symbol, r.market_cap]))
    : null;

  // Recording start: beat/miss and revisions are forward-only, so how long this
  // has been running IS part of the answer and travels with it.
  const recordingSince = rows.length ? rows[rows.length - 1].snap_date : null;

  return {
    weights, asOf, recordingSince,
    snapshots: rows.map(r => ({
      symbol: r.symbol, snapDate: r.snap_date,
      trendEndDate: r.trend_end_date, epsAvg: r.eps_avg, analysts: r.analysts,
    })),
  };
}

/** Quarter buckets that actually have rows, newest first. */
function quartersFrom(rows) {
  const seen = new Set();
  for (const r of rows) {
    if (r.period_type !== 'quarter' || !r.period_end) continue;
    const d = new Date(r.period_end + 'T00:00:00Z');
    const q = Math.floor(d.getUTCMonth() / 3) * 3 + 3;
    seen.add(`${d.getUTCFullYear()}-${String(q).padStart(2, '0')}`);
  }
  return [...seen].sort().reverse();
}

async function context(market) {
  return cached(`ctx:${market}`, async () => {
    const [rows, scopes, c] = await Promise.all([loadRows(market), loadScopes(market), loadConsensus(market)]);
    return {
      rows, scopes, quarters: quartersFrom(rows),
      weights: c.weights, weightsAsOf: c.asOf,
      snapshots: c.snapshots, recordingSince: c.recordingSince,
    };
  });
}

/** One scope, one quarter. */
async function scopeReport(market, scopeKey, quarter) {
  const ctx = await context(market);
  const q = quarter || ctx.quarters[0];
  return cached(`scope:${market}:${scopeKey}:${q}`, () => {
    const constituents = ctx.scopes.get(scopeKey) || [];
    const symbols = new Set(constituents.map(c => c.symbol));
    const scoped = ctx.rows.filter(r => symbols.has(r.symbol));
    const report = aggregateQuarter({
      rows: scoped.map(toAggRow), constituents, quarter: q,
      weights: ctx.weights, weightsAsOf: ctx.weightsAsOf,
      issuerGroups: issuerGroups(ctx.rows),
    });

    // Beat/miss needs what the aggregator deliberately does not carry: the
    // landing date and the backfill flag, which is how "was this consensus
    // recorded BEFORE the result?" gets answered at all.
    const [qy, qm] = q.split('-');
    const quarterEnd = new Date(Date.UTC(Number(qy), Number(qm), 0)).toISOString().slice(0, 10);
    const quarterStart = new Date(Date.UTC(Number(qy), Number(qm) - 3, 1)).toISOString().slice(0, 10);
    const results = scoped
      .filter(r => r.period_type === 'quarter' && r.period_end >= quarterStart && r.period_end <= quarterEnd)
      .map(r => ({
        symbol: r.symbol, periodEnd: r.period_end, eps: r.eps,
        firstSeenAt: r.first_seen_at, backfilled: r.backfilled,
      }));
    const snapshots = ctx.snapshots.filter(s => symbols.has(s.symbol));

    return {
      scope: scopeKey,
      ...report,
      surprise: scopeSurprise({ results, snapshots, recordingSince: ctx.recordingSince }),
      revisions: revisionBreadth(snapshots, {}),
    };
  });
}

/** Every scope for one quarter — the market-wide view. */
async function allScopes(market, quarter) {
  const ctx = await context(market);
  const q = quarter || ctx.quarters[0];
  return cached(`all:${market}:${q}`, async () => {
    const out = [];
    for (const key of ctx.scopes.keys()) out.push(await scopeReport(market, key, q));
    return {
      market, quarter: q, quarters: ctx.quarters,
      weightsAsOf: ctx.weightsAsOf,
      scopes: out.map(({ reporting, excluded, contributions, bridge, ...rest }) => ({
        ...rest,
        // The market-wide table doesn't need per-symbol detail; the drill-down
        // endpoint carries it.
        topContributor: contributions[0] || null,
      })),
      // Stated because it looks like a bug otherwise: a symbol in two sectors
      // appears in both rows but once in any deduped market total, so the
      // column does not add up. That is correct, and silence about it invites a
      // bug report.
      note: 'Scope rows overlap: a symbol in two sectors appears in both, so these rows do not sum to a market total.',
    };
  });
}

async function coverage(market) {
  const ctx = await context(market);
  const latest = ctx.quarters[0] || null;
  const perScope = [];
  for (const key of ctx.scopes.keys()) {
    const r = await scopeReport(market, key, latest);
    perScope.push({ scope: key, quarter: latest, coverage: r.coverage });
  }
  const newestFetch = ctx.rows.reduce((m, r) => (r.fetched_at > m ? r.fetched_at : m), '');
  return { market, latestQuarter: latest, lastIngest: newestFetch || null, scopes: perScope };
}

module.exports = { scopeReport, allScopes, coverage, context, invalidateCache, quartersFrom, toAggRow };
