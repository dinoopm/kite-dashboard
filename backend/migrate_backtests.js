// Run once: node migrate_backtests.js
//
// Saved backtest runs persistence. Supabase's JS client can't run DDL, so this
// prints the CREATE TABLE statement for you to paste into the Supabase SQL
// editor, then verifies the table is reachable. No seed data — runs are saved
// from the Backtest UI.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- Strategy backtester saved runs
create table if not exists backtest_runs (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('single','basket')),
  label       text not null,           -- 'RELIANCE · SuperTrend Swing' / 'Sector: NIFTY IT · Breakout'
  symbol      text,                    -- single runs only
  token       text,
  scope       jsonb,                   -- basket runs: { type, sectorKey?, themeId? }
  strategy_id text not null,
  params      jsonb not null,
  metrics     jsonb not null,          -- summary stats for list rendering without loading result
  result      jsonb not null,          -- trades + curves (single) / aggregate + perStock (basket)
  from_date   date,
  to_date     date,
  created_at  timestamptz default now()
);
create index if not exists idx_backtest_runs_created on backtest_runs(created_at desc);
create index if not exists idx_backtest_runs_symbol  on backtest_runs(symbol);
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

  const { error } = await supabase.from('backtest_runs').select('id').limit(1);
  if (error) {
    console.log(`❌ backtest_runs: NOT reachable — ${error.message}`);
    console.log('   → Paste the SQL above into the Supabase SQL editor, then re-run.');
  } else {
    console.log('✓ backtest_runs: reachable');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
