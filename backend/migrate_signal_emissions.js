// Run once: node migrate_signal_emissions.js
//
// One row per (signal, day, symbol): every time any signal in the registry
// fired. This is the table that makes the app falsifiable — without a record of
// what was claimed, no claim can ever be checked, and every indicator on the
// dashboard stays an untested assertion.
//
// `source` distinguishes evidence quality and is deliberately stored per row:
//   'recorded'      — written the day it fired, before the outcome existed.
//   'reconstructed' — recomputed later from stored OHLC. Faithful (bhavcopy is
//                     not revised) but a weaker standard, and the scorecard
//                     reports the two separately rather than pooling them.
//
// Supabase's JS client can't run DDL, so this prints the CREATE TABLE for the
// SQL editor and then verifies the table is reachable.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- Every signal firing, one row per (signal, day, symbol)
create table if not exists signal_emissions (
  signal      text not null,
  snap_date   date not null,
  symbol      text not null,
  source      text not null default 'reconstructed',
  meta        jsonb,
  created_at  timestamptz default now(),
  primary key (signal, snap_date, symbol)
);
create index if not exists signal_emissions_signal_idx on signal_emissions (signal, snap_date);
create index if not exists signal_emissions_symbol_idx on signal_emissions (symbol, snap_date desc);
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
  const { error } = await supabase.from('signal_emissions').select('signal').limit(1);
  if (error) {
    console.log(`❌ signal_emissions: NOT reachable — ${error.message}`);
    console.log('   → Paste the SQL above into the Supabase SQL editor, then re-run.');
    process.exitCode = 1;
  } else {
    console.log('✓ signal_emissions: reachable');
    console.log('   → Populate it with: node signals/backfill.js');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
