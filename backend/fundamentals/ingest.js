// ─── Storing what companies actually reported ────────────────────────────────
//
// Run: node fundamentals/ingest.js --market=IN [--backfill] [--limit=5]
//
// Today every earnings figure in this app is scraped per-symbol on demand and
// thrown away, which is why no sector-level question can be asked: there is
// nowhere to sum from. This walks the constituent universe once a night and
// keeps the answers.
//
// It calls the SAME code paths the instrument pages render — screener.in via
// screener/fetchHtml.js and pickScreenerBasis, Yahoo via alpaca.js's
// fetchUsStatements. A second implementation of "what did this company earn"
// would drift, and the sector aggregate would then disagree with the statement
// a user opens to check it.
//
// Politeness matters here in a way it does not for a page view. 239 Indian
// symbols a night is 239 screener.in page loads; the file's own comment says
// the aggressive cache "keeps us off screener's radar". So: one at a time, with
// a pause, and never in parallel.

require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const { fetchScreenerHTML } = require('../screener/fetchHtml');
const {
  parseScreenerQuarterly, parseScreenerAnnualPL, pickScreenerBasis,
} = require('../screener/screenerParse');

const SCREENER_GAP_MS = 1000;   // one page a second, and no concurrency
const YAHOO_CONCURRENCY = 4;
const UPSERT_CHUNK = 500;

// India's lenders, by the sector they sit in. Presence of a Provisions row is
// the primary signal, but a quarter where screener renders no provisions line
// would otherwise silently reclassify a bank as an industrial company and hand
// it the wrong bridge.
const IN_FINANCIAL_SECTORS = new Set([
  'NSE:NIFTY BANK', 'NSE:NIFTY PSU BANK', 'NSE:NIFTY PRIVATE BANK',
  'NSE:NIFTY FINANCIAL SERVICES',
]);

const ENV_PATH = require('node:path').resolve(__dirname, '../../.env');

/**
 * Fail with something a person can act on.
 *
 * Without this, a missing .env surfaces as `supabaseUrl is required.` thrown
 * from inside the Supabase client — no mention of which variable, which file,
 * or that a .env is involved at all. That matters more here than elsewhere in
 * this repo because most backend scripts resolve '../.env' relative to the
 * WORKING DIRECTORY and so only work when run from backend/, while this one
 * resolves against its own location. Someone who has both habits deserves to be
 * told which file was actually consulted.
 */
function requireDbConfig() {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'].filter(k => !process.env[k]);
  if (!missing.length) return;
  throw new Error(
    `${missing.join(' and ')} not set.\n` +
    `  Looked for a .env at: ${ENV_PATH}\n` +
    `  (this script resolves .env against its own path, so the working directory does not matter)`
  );
}

const supabase = () => {
  requireDbConfig();
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
};

/** Last day of a month, as ISO. Screener's "Jun 2026" means the quarter ENDING June. */
function monthEnd(year, month) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/**
 * One stored row.
 *
 * `first_seen_at` is deliberately ABSENT from everything this builds. PostgREST
 * updates every column an upsert sends, so including it would rewrite the
 * vintage on every nightly run and destroy the one thing it exists for — the
 * column's `default now()` fires on INSERT only, which is exactly the wanted
 * behaviour. There is a test asserting no builder here ever emits it.
 */
const buildRow = (market, symbol, periodType, periodEnd, src, { backfill, unit, basis, source, isFinancial }) => ({
  market,
  symbol,
  period_type: periodType,
  period_end: periodEnd,
  label: src.label ?? null,
  eps: src.eps ?? null,
  net_profit: src.netProfit ?? null,
  revenue: src.revenue ?? null,
  operating_profit: src.operatingProfit ?? null,
  opm: src.opm ?? null,
  other_income: src.otherIncome ?? null,
  interest: src.interest ?? null,
  depreciation: src.depreciation ?? null,
  provisions: src.provisions ?? null,
  pbt: src.pbt ?? null,
  tax_pct: src.taxPct ?? null,
  is_financial: Boolean(isFinancial || src.provisions != null),
  unit,
  basis,
  source,
  backfilled: Boolean(backfill),
  fetched_at: new Date().toISOString(),
});

/** screener.in columns → stored rows. */
function indiaRows(symbol, { quarters = [], annuals = [], basis }, opts = {}) {
  const rows = [];
  const financial = opts.isFinancial || quarters.some(q => q.provisions != null);
  const common = { ...opts, unit: 'INR_CR', basis, source: 'screener.in', isFinancial: financial };
  for (const q of quarters) {
    if (q.month == null || q.year == null) continue;
    rows.push(buildRow('IN', symbol, 'quarter', monthEnd(q.year, q.month),
      { ...q, revenue: q.totalIncome }, common));
  }
  for (const a of annuals) {
    if (a.month == null || a.year == null) continue;
    rows.push(buildRow('IN', symbol, 'annual', monthEnd(a.year, a.month),
      { ...a, revenue: a.totalIncome }, common));
  }
  return rows;
}

/** Yahoo/SEC statement rows → stored rows. */
function usRows(symbol, statements, opts = {}) {
  const rows = [];
  const common = { ...opts, unit: 'USD', basis: null, source: 'yahoo' };
  const map = (r) => ({
    label: r.label,
    eps: r.eps,
    netProfit: r.netIncome,
    revenue: r.revenue,
    operatingProfit: r.operatingIncome,
    opm: r.operatingMargin,
    otherIncome: null,
    interest: r.interestExpense,
    depreciation: null,
    provisions: null,
    pbt: r.pretaxIncome,
    // Stored as a RATE like screener's, not as the absolute tax figure Yahoo
    // gives, or the bridge would compare a percentage against a currency.
    taxPct: (r.tax != null && r.pretaxIncome) ? (r.tax / r.pretaxIncome) * 100 : null,
  });
  for (const r of statements.quarterly || []) {
    if (!r.endDate) continue;
    rows.push(buildRow('US', symbol, 'quarter', r.endDate, map(r), common));
  }
  for (const r of statements.annual || []) {
    if (!r.endDate) continue;
    rows.push(buildRow('US', symbol, 'annual', r.endDate, map(r), common));
  }
  return rows;
}

async function upsertFundamentals(rows) {
  if (!rows.length) return 0;
  const db = supabase();
  let saved = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const { error } = await db.from('stock_fundamentals')
      .upsert(chunk, { onConflict: 'market,symbol,period_type,period_end' });
    if (error) throw new Error(`stock_fundamentals: ${error.message}`);
    saved += chunk.length;
  }
  return saved;
}

/** The Indian universe, with the sector each symbol sits in. */
async function indiaUniverse() {
  const { data, error } = await supabase()
    .from('sector_constituents').select('symbol,name,sector_key');
  if (error) throw new Error(`sector_constituents: ${error.message}`);
  const bySymbol = new Map();
  for (const r of data || []) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, { symbol: r.symbol, name: r.name, sectors: [] });
    bySymbol.get(r.symbol).sectors.push(r.sector_key);
  }
  return [...bySymbol.values()];
}

async function ingestIndia({ symbols = null, backfill = false, limit = 0, onProgress = null } = {}) {
  const universe = symbols
    ? symbols.map(s => ({ symbol: s, sectors: [] }))
    : await indiaUniverse();
  const list = limit ? universe.slice(0, limit) : universe;

  const rows = [];
  let ok = 0, failed = 0;
  const failures = [];
  for (const entry of list) {
    try {
      const isFinancial = entry.sectors.some(s => IN_FINANCIAL_SECTORS.has(s));
      const { rows: quarters, basis } = await pickScreenerBasis(entry.symbol, {
        consolidated: true,
        parse: parseScreenerQuarterly,
        latestOf: (qs) => Math.max(...qs.map(q => q.sortKey)),
        fetchHtml: fetchScreenerHTML,
        tag: 'fundamentals-ingest',
      });
      // The annual page is the same HTML, already cached by the fetch above, so
      // this costs nothing extra.
      let annuals = [];
      try {
        const { html } = await fetchScreenerHTML(entry.symbol,
          { consolidated: basis === 'consolidated' });
        annuals = parseScreenerAnnualPL(html);
      } catch { /* a company with no P&L section still has usable quarters */ }

      rows.push(...indiaRows(entry.symbol, { quarters, annuals, basis }, { backfill, isFinancial }));
      ok++;
    } catch (err) {
      failed++;
      failures.push({ symbol: entry.symbol, error: err.message });
    }
    if (onProgress) onProgress({ done: ok + failed, total: list.length, failed });
    await new Promise(r => setTimeout(r, SCREENER_GAP_MS));
  }
  const saved = await upsertFundamentals(rows);
  return { market: 'IN', symbols: list.length, ok, failed, rows: rows.length, saved, failures };
}

async function ingestUS({ symbols = null, backfill = false, limit = 0, onProgress = null } = {}) {
  const { fetchUsStatements } = require('../alpaca');
  const { getSP500, getNasdaq100 } = require('../usUniverses');

  let universe;
  if (symbols) {
    universe = symbols.map(s => ({ symbol: s, sector: null }));
  } else {
    const [spx, ndx] = await Promise.all([getSP500(), getNasdaq100()]);
    // The two indices overlap heavily — most of the Nasdaq-100 sits inside the
    // S&P 500 — so the union is deduped here rather than fetched twice.
    const seen = new Map();
    for (const r of [...spx, ...ndx]) if (!seen.has(r.symbol)) seen.set(r.symbol, r);
    universe = [...seen.values()];
  }
  const list = limit ? universe.slice(0, limit) : universe;

  const rows = [];
  let ok = 0, failed = 0, i = 0;
  const failures = [];
  const worker = async () => {
    while (i < list.length) {
      const entry = list[i++];
      try {
        const statements = await fetchUsStatements(entry.symbol.toUpperCase());
        // GICS sector is a far more reliable lender signal than guessing at
        // Yahoo's provision field names, which vary by filer.
        const isFinancial = /financial/i.test(entry.sector || '');
        rows.push(...usRows(entry.symbol.toUpperCase(), statements, { backfill, isFinancial }));
        ok++;
      } catch (err) {
        failed++;
        failures.push({ symbol: entry.symbol, error: err.message });
      }
      if (onProgress) onProgress({ done: ok + failed, total: list.length, failed });
    }
  };
  await Promise.all(Array.from({ length: Math.min(YAHOO_CONCURRENCY, list.length) }, worker));
  const saved = await upsertFundamentals(rows);
  return { market: 'US', symbols: list.length, ok, failed, rows: rows.length, saved, failures };
}

const runIngest = (opts = {}) =>
  (opts.market === 'US' ? ingestUS(opts) : ingestIndia(opts));

module.exports = {
  runIngest, ingestIndia, ingestUS,
  indiaRows, usRows, buildRow, monthEnd, upsertFundamentals,
  IN_FINANCIAL_SECTORS,
};

if (require.main === module) {
  const arg = (name, dflt) => {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : dflt;
  };
  const market = (arg('market', 'IN') || 'IN').toUpperCase();
  // backfilled is set ONLY here, never inferred: the first run pulls ~13
  // quarters at once and stamps them all with today, which read naively would
  // claim three years of companies reported this morning.
  const backfill = process.argv.includes('--backfill');
  const limit = Number(arg('limit', 0)) || 0;

  // Checked up front: discovering a missing credential AFTER scraping 239
  // pages would waste the fetch and, worse, teach screener.in nothing good
  // about this client.
  try { requireDbConfig(); }
  catch (err) { console.error(err.message); process.exit(1); }

  runIngest({
    market, backfill, limit,
    onProgress: ({ done, total, failed }) =>
      process.stdout.write(`  ${done}/${total} (${failed} failed)\r`),
  })
    .then(r => {
      process.stdout.write('\n');
      console.log(`${r.market}: ${r.saved} rows from ${r.ok} symbols (${r.failed} failed)${backfill ? ', marked backfilled' : ''}`);
      for (const f of r.failures.slice(0, 10)) console.log(`   ${f.symbol}: ${f.error}`);
      if (r.failures.length > 10) console.log(`   …and ${r.failures.length - 10} more`);
    })
    .catch(err => { console.error(err.message); process.exit(1); });
}
