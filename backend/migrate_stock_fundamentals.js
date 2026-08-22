// Run once: node migrate_stock_fundamentals.js
//
// One row per (market, symbol, period_type, period_end): the reported income
// statement as the source currently renders it. This is what makes a sector's
// earnings answerable at all — today every figure is scraped per-symbol on
// demand and thrown away, so "did this sector's profit pool grow?" has nowhere
// to be computed from.
//
// Three columns carry more weight than they look:
//
//   unit           'INR_CR' | 'USD'. A column, not a comment: the same table
//                  holds ₹ crore and absolute dollars, and a comparison whose
//                  two periods disagree on it is rejected rather than computed.
//   first_seen_at  when this period first appeared. A proxy for the reporting
//                  date, and the beginning of a vintage record — the thing whose
//                  absence keeps analyst_target_upside in BLOCKED_SIGNALS.
//   backfilled     set ONLY by `--backfill`, never inferred.
//
// Two traps worth stating loudly, because both are silent when wrong:
//
// 1. first_seen_at MUST be omitted from the upsert payload. PostgREST updates
//    every column you send, so including it rewrites the vintage on every
//    nightly run and destroys the one thing the column exists for. `default
//    now()` only fires on INSERT, which is exactly the behaviour wanted.
//
// 2. The first ingest pulls ~13 quarters per symbol at once and stamps them all
//    with today. Read naively that claims three years of companies reported this
//    morning, which is why those rows are marked backfilled and the tracker
//    reports a landing date only inside a reporting-lag BAND (roughly 10-75 days
//    after period_end for India, where SEBI LODR allows 45; 10-60 for the US).
//    Results arrive weeks after a quarter closes — a proximity test would
//    suppress every honest row forever.
//
// Upserts overwrite, so this holds the CURRENT view with a vintage stamp. It is
// not a revision archive: a restatement replaces what was there.
//
// Supabase's JS client can't run DDL, so this prints the CREATE TABLE for the
// SQL editor and then verifies the table is reachable.
require('dotenv').config({ path: __dirname + '/../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- Reported income statements, one row per company-period
create table if not exists stock_fundamentals (
  market           text not null,          -- 'IN' | 'US'
  symbol           text not null,
  period_type      text not null,          -- 'quarter' | 'annual'
  period_end       date not null,          -- fiscal period END: the only comparable key
  label            text,                   -- 'Jun 2026' / "Q2 '26", as the source rendered it
  eps              numeric,
  net_profit       numeric,
  revenue          numeric,
  operating_profit numeric,
  opm              numeric,
  other_income     numeric,
  interest         numeric,
  depreciation     numeric,
  provisions       numeric,                -- lenders only; null elsewhere
  pbt              numeric,
  tax_pct          numeric,
  is_financial     boolean not null default false,
  unit             text not null,          -- 'INR_CR' | 'USD'
  basis            text,                   -- 'consolidated' | 'standalone' | null (US)
  source           text not null,          -- 'screener.in' | 'yahoo'
  backfilled       boolean not null default false,
  first_seen_at    timestamptz not null default now(),  -- NEVER sent in an upsert
  fetched_at       timestamptz not null default now(),
  primary key (market, symbol, period_type, period_end)
);
create index if not exists stock_fundamentals_scope_idx
  on stock_fundamentals (market, period_type, period_end desc);
create index if not exists stock_fundamentals_symbol_idx
  on stock_fundamentals (market, symbol, period_end desc);
`;

async function main() {
  console.log('\n=== Run this SQL in your Supabase SQL editor (one-time) ===');
  console.log(DDL);
  console.log('===========================================================\n');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.log('SUPABASE_URL / SUPABASE_SERVICE_KEY not set — skipping verification.');
    return;
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { error } = await supabase.from('stock_fundamentals').select('symbol').limit(1);
  if (error) {
    console.log(`❌ stock_fundamentals: NOT reachable — ${error.message}`);
    console.log('   → Paste the SQL above into the Supabase SQL editor, then re-run.');
    process.exitCode = 1;
  } else {
    console.log('✓ stock_fundamentals: reachable');
    console.log('   → Populate it with: node fundamentals/ingest.js --market=IN --backfill');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
