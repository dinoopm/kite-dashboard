// ─── Quant Stock-Picks engine ───────────────────────────────────────────────
// Deterministic, transparent per-symbol factor aggregation over a chosen period,
// built from the existing market-data feeds (top gainers/losers, volume gainers,
// 52-week high/low, large deals), with ASM/GSM surveillance names HARD-EXCLUDED
// and a Volume-Authenticity / HFT-trap heuristic so faked volume can't pump the
// score. FII/DII is market-wide → used only for a regime read, never per stock.
//
// The engine returns RAW factor values per stock; normalization (percentile
// rank), weighting and ranking happen client-side so weight sliders re-rank
// instantly (mirrors frontend/src/pages/us/UsScreener.jsx). The AI brief only
// narrates the already-ranked output.

const { createClient } = require('@supabase/supabase-js');
const { llm, withTimeout, contentToString } = require('../ai/sqlAgent');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const round = (v, p = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(p));

// Supabase caps a select at 1000 rows; page through with .range() to get all.
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

// Approximate number of NSE trading days in [from,to] (used to scale "persistence").
const tradingDaysBetween = (from, to) => {
  const d0 = new Date(from), d1 = new Date(to);
  const cal = Math.round((d1 - d0) / 86400000) + 1;
  return Math.max(1, Math.round(cal * 5 / 7));
};

// ─── Main: build the raw factor universe for [from, to] ─────────────────────
async function buildFactorUniverse({ from, to }) {
  const snapshot = from === to;
  const periodDays = tradingDaysBetween(from, to);
  const inPeriod = (q) => q.gte('trade_date', from).lte('trade_date', to);

  // Latest 52-week snapshot date within the window (the feed is a full daily
  // snapshot of every stock's trailing high/low — we only need one day of it).
  const { data: snapRow } = await supabase
    .from('nse_52_week_high_low').select('trade_date')
    .gte('trade_date', from).lte('trade_date', to)
    .order('trade_date', { ascending: false }).limit(1);
  const snapDate = snapRow?.[0]?.trade_date || null;

  const [gl, vg, ld, fii, poi, surv, sectors, fw] = await Promise.all([
    fetchAll('top_gainers_losers', 'symbol,trade_date,category,pct_change,ltp', inPeriod),
    fetchAll('volume_gainers', 'symbol,trade_date,week1_vol_change,week2_vol_change,pct_change,ltp,turnover', inPeriod),
    fetchAll('large_deals', 'symbol,trade_date,deal_type,quantity,price,client_name', inPeriod),
    fetchAll('fii_dii_activity', 'trade_date,fii_net,dii_net', inPeriod),
    fetchAll('participant_oi', 'trade_date,future_index_long,future_index_short', (q) => inPeriod(q).eq('client_type', 'FII')),
    fetchAll('surveillance_stocks', 'symbol,measure,stage'),
    fetchAll('sector_constituents', 'symbol,name,sector_key'),
    snapDate ? fetchAll('nse_52_week_high_low', 'symbol,series,company_name,adjusted_52_week_high,high_date,adjusted_52_week_low,low_date', (q) => q.eq('trade_date', snapDate)) : Promise.resolve([]),
  ]);

  // Lookup maps
  const survSet = new Map(surv.map(s => [s.symbol, s.measure || 'ASM']));
  const sectorMap = new Map();
  for (const s of sectors) if (!sectorMap.has(s.symbol)) sectorMap.set(s.symbol, { name: s.name, sector: s.sector_key });
  const fwMap = new Map();
  for (const r of fw) if (r.symbol && (!fwMap.has(r.symbol) || r.series === 'EQ')) fwMap.set(r.symbol, r);

  // Per-symbol accumulators (only for "active" symbols: gainers/losers, volume, deals)
  const A = new Map();
  const get = (sym) => {
    if (!A.has(sym)) A.set(sym, {
      gainerDates: new Map(), loserDates: new Set(),       // momentum
      volDates: new Set(), w1: [], volPcts: [],            // volume + authenticity
      buyVal: 0, sellVal: 0, clientNet: new Map(),         // deals (per-client net catches round-trips)
      lastLtp: null, lastLtpDate: null,
    });
    return A.get(sym);
  };
  const noteLtp = (a, ltp, date) => { if (ltp != null && (!a.lastLtpDate || date > a.lastLtpDate)) { a.lastLtp = ltp; a.lastLtpDate = date; } };

  for (const r of gl) {
    if (!r.symbol) continue;
    const a = get(r.symbol);
    if (r.category === 'GAINER') a.gainerDates.set(r.trade_date, r.pct_change ?? 0);
    else if (r.category === 'LOSER') a.loserDates.add(r.trade_date);
    noteLtp(a, r.ltp, r.trade_date);
  }
  for (const r of vg) {
    if (!r.symbol) continue;
    const a = get(r.symbol);
    a.volDates.add(r.trade_date);
    if (r.week1_vol_change != null) a.w1.push(r.week1_vol_change);
    if (r.pct_change != null) a.volPcts.push(Math.abs(r.pct_change));
    noteLtp(a, r.ltp, r.trade_date);
  }
  for (const r of ld) {
    if (!r.symbol) continue;
    const a = get(r.symbol);
    const val = (r.quantity || 0) * (r.price || 0);
    const name = r.client_name || '?';
    if (r.deal_type === 'BUY') { a.buyVal += val; a.clientNet.set(name, (a.clientNet.get(name) || 0) + val); }
    else if (r.deal_type === 'SELL') { a.sellVal += val; a.clientNet.set(name, (a.clientNet.get(name) || 0) - val); }
  }
  // Universe seeding: the movers/deals feeds only surface "active" names, which
  // misses stocks quietly printing fresh 52-week highs (or lows). Any EQ symbol
  // whose 52-week high/low date falls inside the window joins the universe too.
  for (const r of fw) {
    if (!r.symbol || (r.series && r.series !== 'EQ')) continue;
    const freshHigh = r.high_date && r.high_date >= from && r.high_date <= to;
    const freshLow = r.low_date && r.low_date >= from && r.low_date <= to;
    if (freshHigh || freshLow) get(r.symbol);
  }

  // ─── Build per-symbol factor rows ──────────────────────────────────────────
  const stocks = [];
  let excludedCount = 0;
  const excludedSample = [];

  for (const [symbol, a] of A) {
    if (survSet.has(symbol)) { excludedCount++; if (excludedSample.length < 8) excludedSample.push(`${symbol} (${survSet.get(symbol)})`); continue; }

    // Momentum
    const gainerDays = a.gainerDates.size;
    const loserDays = a.loserDates.size;
    const avgGainPct = gainerDays ? mean([...a.gainerDates.values()]) : 0;
    const momentumRaw = (gainerDays - loserDays) + avgGainPct / 100;

    // Volume conviction + authenticity (HFT-trap heuristic)
    const volSurgeDays = a.volDates.size;
    const avgW1 = a.w1.length ? mean(a.w1) : 0;          // % vs 1-week avg
    const avgAbsPctOnVol = a.volPcts.length ? mean(a.volPcts) : 0;
    const rawVolStrength = volSurgeDays + avgW1 / 100;
    // (a) price corroboration: a real volume surge moves price.
    const corroboration = clamp01(avgAbsPctOnVol / (0.5 + avgW1 / 200));
    // (b) persistence: sustained over several days, not a one-day blip (n/a for snapshot).
    const persistence = snapshot ? 0.5 : clamp01(volSurgeDays / Math.min(periodDays, 5));
    // (c) churn penalty: flip-flopping gainer<->loser with heavy volume.
    const churnRatio = (gainerDays + loserDays) ? Math.min(gainerDays, loserDays) / (gainerDays + loserDays) : 0;
    // Authenticity is only meaningful when there's actually a volume surge to judge.
    const authenticity = volSurgeDays > 0
      ? clamp01(0.5 * corroboration + 0.3 * persistence + 0.2 * (1 - churnRatio))
      : null;
    const volumeRaw = authenticity != null ? rawVolStrength * authenticity : 0; // faked volume can't pump the factor
    const bigSurge = avgW1 > 100;                        // volume more than doubled
    const trapRisk = volSurgeDays > 0 && bigSurge && authenticity < 0.45;
    let trapReason = null;
    if (trapRisk) {
      if (corroboration < 0.4) trapReason = `vol +${Math.round(avgW1)}% but price ~flat (${round(avgAbsPctOnVol, 1)}% avg move)`;
      else if (churnRatio > 0.3) trapReason = `churn: ${gainerDays} up / ${loserDays} down days`;
      else if (!snapshot && persistence < 0.4) trapReason = `one-day blip (vol-gainer ${volSurgeDays}/${periodDays}d)`;
      else trapReason = `low-conviction volume surge`;
    }

    // 52-week strength (from the latest snapshot in the window)
    const fwr = fwMap.get(symbol);
    const high = fwr?.adjusted_52_week_high ?? null;
    const low = fwr?.adjusted_52_week_low ?? null;
    const madeNewHigh = !!(fwr?.high_date && fwr.high_date >= from && fwr.high_date <= to);
    const madeNewLow = !!(fwr?.low_date && fwr.low_date >= from && fwr.low_date <= to);
    // Proximity needs a price from near the window end — the movers-feed LTP can
    // be weeks old in a long lookback (spike-then-fade names would look strong).
    const ltpFresh = a.lastLtpDate && (new Date(to) - new Date(a.lastLtpDate)) <= 7 * 86400000;
    const nearHighPct = (ltpFresh && a.lastLtp != null && high) ? clamp01(a.lastLtp / high) : null; // 1.0 = at 52w high
    const fiftyTwoRaw = (madeNewHigh ? 1 : 0) - (madeNewLow ? 1 : 0) + (nearHighPct != null ? (nearHighPct - 0.8) : 0);

    // Institutional accumulation — net large-deal buy value with a breadth
    // multiplier, so five buyers beat one whale writing the same cheque.
    // Deal-conviction guard: HFT/prop desks round-trip huge gross volumes
    // through bulk deals (same names on both sides, net ≈ 0), which nets to a
    // small positive that used to rank high. Conviction = |net| / gross scales
    // that appearance of accumulation back down to its real size.
    const dealsNetValue = a.buyVal - a.sellVal;          // ₹ (qty × price)
    const dealsGross = a.buyVal + a.sellVal;
    const netRatio = dealsGross ? Math.abs(dealsNetValue) / dealsGross : 0;
    const dealConviction = clamp01(2 * netRatio);        // full conviction when net ≥ half of gross
    // Breadth counts genuine accumulators: clients whose own buys−sells net ≥ ₹1 cr.
    const dealBuyers = [...a.clientNet.values()].filter(v => v >= 1e7).length;
    const roundTrippers = [...a.clientNet.values()].filter(v => Math.abs(v) < 1e6).length; // bought & sold ~flat
    const breadthBoost = 1 + 0.3 * Math.log1p(Math.max(0, dealBuyers - 1));
    const dealChurn = dealsGross > 25e7 && netRatio < 0.15;
    // Churned flow is noise, not a smaller signal: percentile ranking would
    // still put any positive residue above the no-deals majority, so flagged
    // names get zero (= neutral mid-rank), not a scaled-down positive.
    const dealsRaw = dealChurn ? 0 : (dealsNetValue > 0 ? dealsNetValue * breadthBoost : dealsNetValue) * dealConviction;
    const dealChurnReason = dealChurn
      ? `₹${round(dealsGross / 1e7, 0)}cr gross traded both ways → net only ₹${round(dealsNetValue / 1e7, 1)}cr (${round(netRatio * 100, 1)}% conviction)${roundTrippers ? `; ${roundTrippers} name(s) bought & sold ~flat` : ''}`
      : null;

    const info = sectorMap.get(symbol) || {};
    stocks.push({
      symbol,
      name: info.name || fwr?.company_name || symbol,
      sector: info.sector || null,
      lastLtp: round(a.lastLtp),
      factors: {
        momentumRaw: round(momentumRaw, 3), gainerDays, loserDays, avgGainPct: round(avgGainPct, 2),
        volumeRaw: round(volumeRaw, 3), rawVolStrength: round(rawVolStrength, 3), volSurgeDays,
        avgW1VolChange: round(avgW1, 1), authenticity: authenticity != null ? round(authenticity * 100, 0) : null, trapRisk, trapReason,
        fiftyTwoRaw: round(fiftyTwoRaw, 3), madeNewHigh, madeNewLow, nearHighPct: round(nearHighPct, 3),
        dealsRaw: round(dealsRaw, 0), dealsNetValueCr: round(dealsNetValue / 1e7, 2), dealBuyers,
        dealsGrossCr: round(dealsGross / 1e7, 1), dealConviction: round(dealConviction * 100, 0), dealChurn, dealChurnReason,
      },
    });
  }

  // Market regime from FII/DII (₹ crore, market-wide)
  const fiiNet = round(fii.reduce((s, r) => s + (r.fii_net || 0), 0), 0);
  const diiNet = round(fii.reduce((s, r) => s + (r.dii_net || 0), 0), 0);
  const totalNet = round((fiiNet || 0) + (diiNet || 0), 0);

  // FII index-futures positioning (participant OI) sharpens the regime read:
  // cash flows say what institutions DID, futures say how they're POSITIONED.
  let derivatives = null;
  if (poi.length) {
    const rows = [...poi].sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1));
    const first = rows[0], last = rows[rows.length - 1];
    const net = (last.future_index_long || 0) - (last.future_index_short || 0);
    const ratio = last.future_index_short ? (last.future_index_long || 0) / last.future_index_short : null;
    const lean = ratio == null ? 'balanced' : ratio >= 1.05 ? 'net long' : ratio <= 0.95 ? 'net short' : 'balanced';
    derivatives = {
      date: last.trade_date, futLong: last.future_index_long, futShort: last.future_index_short,
      net, ratio: round(ratio, 2), lean,
      deltaNet: net - ((first.future_index_long || 0) - (first.future_index_short || 0)),
    };
  }
  const cashScore = totalNet > 5000 ? 1 : totalNet < -5000 ? -1 : 0;
  const derivScore = !derivatives ? 0 : derivatives.lean === 'net long' ? 1 : derivatives.lean === 'net short' ? -1 : 0;
  const score = cashScore + derivScore;
  const regimeLabel = !derivatives
    ? (cashScore > 0 ? 'Risk-on — net institutional buying'
      : cashScore < 0 ? 'Risk-off — net institutional selling'
      : 'Neutral / mixed institutional flows')
    : score >= 2 ? 'Risk-on — cash buying + FII long index futures'
    : score <= -2 ? 'Risk-off — cash selling + FII short index futures'
    : score === 1 ? 'Tilted risk-on — cash flows and FII futures partly aligned'
    : score === -1 ? 'Tilted risk-off — cash flows and FII futures partly aligned'
    : (cashScore !== 0 ? 'Mixed — cash flows and FII futures positioning diverge'
      : 'Neutral / mixed institutional positioning');

  return {
    period: { from, to, snapshot, tradingDays: periodDays, fiftyTwoSnapshotDate: snapDate },
    regime: { fiiNet, diiNet, totalNet, score, derivatives, label: regimeLabel },
    excludedCount, excludedSample,
    universeSize: stocks.length,
    generatedAt: new Date().toISOString(),
    stocks,
  };
}

// ─── Server-side ranking + daily top-25 snapshots (track record) ─────────────
// Snapshots always use DEFAULT_WEIGHTS and trap-exclusion so the stored history
// is one deterministic series, regardless of what sliders a user plays with.
const DEFAULT_WEIGHTS = { momentum: 30, volume: 25, fiftyTwo: 20, deals: 25 };
const FACTOR_RAW = { momentum: 'momentumRaw', volume: 'volumeRaw', fiftyTwo: 'fiftyTwoRaw', deals: 'dealsRaw' };

// Mid-rank percentiles — same math as the client so snapshots match the UI.
function midRankPercentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return values.map(v => {
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    const first = lo;
    hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid + 1; else hi = mid; }
    return n ? ((first + lo) / 2 / n) * 100 : 0;
  });
}

function rankUniverse(stocks, weights = DEFAULT_WEIGHTS, { excludeTraps = true } = {}) {
  const pool = excludeTraps ? stocks.filter(s => !s.factors.trapRisk) : stocks;
  const keys = Object.keys(FACTOR_RAW);
  const cols = {};
  for (const k of keys) cols[k] = midRankPercentiles(pool.map(s => s.factors[FACTOR_RAW[k]] ?? 0));
  const sumW = keys.reduce((a, k) => a + (weights[k] || 0), 0) || 1;
  return pool
    .map((s, i) => {
      const pct = {}; let composite = 0;
      for (const k of keys) { pct[k] = cols[k][i]; composite += (weights[k] / sumW) * pct[k]; }
      return { ...s, pct, composite };
    })
    .sort((a, b) => b.composite - a.composite)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

// Persist the default-weight top 25 for one data-day. Table comes from
// backend/migrate_pick_snapshots.js; a missing table surfaces as an error the
// caller downgrades to a log line.
async function saveDailySnapshot(universe) {
  const snapDate = universe.period.fiftyTwoSnapshotDate || universe.period.to;
  const top = rankUniverse(universe.stocks).slice(0, 25);
  if (!top.length) return { snapDate, saved: 0 };
  const rows = top.map(r => ({
    snap_date: snapDate, symbol: r.symbol, rank: r.rank,
    composite: +r.composite.toFixed(2),
    momentum_pct: +r.pct.momentum.toFixed(1), volume_pct: +r.pct.volume.toFixed(1),
    fifty_two_pct: +r.pct.fiftyTwo.toFixed(1), deals_pct: +r.pct.deals.toFixed(1),
    trap_risk: !!r.factors.trapRisk, last_ltp: r.lastLtp,
  }));
  const { error } = await supabase.from('stock_pick_snapshots').upsert(rows, { onConflict: 'snap_date,symbol' });
  if (error) throw new Error(`stock_pick_snapshots: ${error.message}`);
  return { snapDate, saved: rows.length };
}

// Snapshot history grouped by date (newest first) for the diff/streak view.
async function fetchSnapshotHistory(sinceDate) {
  const { data, error } = await supabase
    .from('stock_pick_snapshots')
    .select('snap_date,symbol,rank,composite,trap_risk,last_ltp')
    .gte('snap_date', sinceDate)
    .order('snap_date', { ascending: false })
    .order('rank', { ascending: true })
    .limit(5000);
  if (error) throw new Error(`stock_pick_snapshots: ${error.message}`);
  const byDate = new Map();
  for (const r of data || []) {
    if (!byDate.has(r.snap_date)) byDate.set(r.snap_date, []);
    byDate.get(r.snap_date).push({ symbol: r.symbol, rank: r.rank, composite: r.composite, trapRisk: r.trap_risk, lastLtp: r.last_ltp });
  }
  return [...byDate.entries()].map(([date, picks]) => ({ date, picks }));
}

// ─── AI brief — narrates the already-ranked deterministic output (Groq) ─────
const PICKS_SYSTEM_PROMPT = `You are a quantitative equity analyst writing a brief on an ALREADY-COMPUTED, deterministic stock ranking for the Indian market (NSE). You did NOT choose these stocks — a transparent factor model did (momentum, volume conviction, 52-week strength, institutional accumulation; surveillance/ASM/GSM names are already excluded, and likely fake/HFT-inflated volume is down-weighted via a Volume Authenticity score). Your job is ONLY to explain the output, not to change it.

Rules:
- Do NOT invent tickers, re-rank, or add/remove names. Use ONLY the provided rows.
- Do NOT give buy/sell/hold advice, entry/exit levels, or price targets.
- Lead with a one-line market-regime read from the FII/DII flows provided.
- For the top names, state which factor(s) drove the rank, citing the given numbers.
- Explicitly call out any name flagged with trap_risk (low volume authenticity) as a caution.
- Explicitly call out any name flagged with deal_churn (bulk deals round-tripped both ways, tiny net vs gross — the "institutional buying" is likely HFT churn, not accumulation).
- Note risks/caveats (crowded momentum, thin breadth, reliance on a single deal, short period).
- Be concise: a short regime paragraph, then a tight bulleted list. Markdown.
- End with exactly: "Deterministic factor summary for research only — not investment advice."`;

async function generatePicksSummary({ period, regime, weights, picks }) {
  const user = [
    `Period: ${period.from} to ${period.to}${period.snapshot ? ' (single-day snapshot)' : ` (${period.tradingDays} trading days)`}.`,
    `Market regime: FII net ₹${regime.fiiNet} cr, DII net ₹${regime.diiNet} cr, combined ₹${regime.totalNet} cr${regime.derivatives ? `; FII index-futures ${regime.derivatives.lean} (long/short ratio ${regime.derivatives.ratio}, net ${regime.derivatives.net} contracts, Δ ${regime.derivatives.deltaNet} over the period)` : ''} — ${regime.label}.`,
    `Active factor weights: ${JSON.stringify(weights)}.`,
    `Top ranked stocks (composite + factor breakdown):`,
    JSON.stringify(picks, null, 2),
    `Write the brief.`,
  ].join('\n\n');

  const resp = await withTimeout(
    llm.invoke([
      { role: 'system', content: PICKS_SYSTEM_PROMPT },
      { role: 'user', content: user },
    ]),
    30000,
    'Picks summary',
  );
  return contentToString(resp.content).trim();
}

module.exports = {
  buildFactorUniverse, generatePicksSummary, PICKS_SYSTEM_PROMPT,
  DEFAULT_WEIGHTS, rankUniverse, saveDailySnapshot, fetchSnapshotHistory,
};
