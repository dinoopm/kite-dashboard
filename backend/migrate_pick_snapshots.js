// Run once: node migrate_pick_snapshots.js
//
// Daily default-weight top-25 quant-pick snapshots — the model's out-of-sample
// track record, written once per day by the server (or POST /api/stock-picks/snapshot).
// Supabase's JS client can't run DDL, so this prints the CREATE TABLE statement
// for you to paste into the Supabase SQL editor, then verifies the table is
// reachable. No seed data — history accumulates from the first snapshot on.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- One row per (day, symbol): the default-weight top-25 quant picks that day
create table if not exists stock_pick_snapshots (
  snap_date      date not null,
  symbol         text not null,
  rank           int  not null,
  composite      numeric,
  momentum_pct   numeric,
  volume_pct     numeric,
  fifty_two_pct  numeric,
  deals_pct      numeric,
  trap_risk      boolean default false,
  last_ltp       numeric,
  created_at     timestamptz default now(),
  primary key (snap_date, symbol)
);
create index if not exists stock_pick_snapshots_symbol_idx on stock_pick_snapshots (symbol, snap_date desc);
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

  const { error } = await supabase.from('stock_pick_snapshots').select('symbol').limit(1);
  if (error) {
    console.log(`❌ stock_pick_snapshots: NOT reachable — ${error.message}`);
    console.log('   → Paste the SQL above into the Supabase SQL editor, then re-run.');
  } else {
    console.log('✓ stock_pick_snapshots: reachable');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
