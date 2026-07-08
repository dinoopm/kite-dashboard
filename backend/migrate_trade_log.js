// Run once: node migrate_trade_log.js
//
// Trade journal store. Kite's API only exposes the CURRENT day's trades, so
// the journal accumulates: the server upserts today's fills whenever the
// Journal page is opened on a trading day (plus a manual sync route), and
// history is backfilled from a Zerodha Console tradebook CSV export.
// Supabase's JS client can't run DDL, so this prints the CREATE TABLE for the
// Supabase SQL editor, then verifies the table is reachable.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- Every fill, from daily Kite sync or Console CSV backfill.
create table if not exists trade_log (
  trade_id     text primary key,        -- exchange trade id (unique per fill)
  order_id     text,
  symbol       text not null,
  exchange     text,
  side         text not null,           -- 'BUY' | 'SELL'
  qty          numeric not null,
  price        numeric not null,
  trade_ts     timestamptz not null,
  imported_via text not null default 'kite',  -- 'kite' | 'csv'
  created_at   timestamptz default now()
);
create index if not exists trade_log_symbol_ts on trade_log (symbol, trade_ts);
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
  const { error } = await supabase.from('trade_log').select('trade_id').limit(1);
  if (error) {
    console.log(`❌ trade_log: NOT reachable — ${error.message}`);
    console.log('   → Paste the SQL above into the Supabase SQL editor, then re-run.');
  } else {
    console.log('✓ trade_log: reachable');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
