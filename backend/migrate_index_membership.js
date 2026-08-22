// Run once: node migrate_index_membership.js
//
// A daily snapshot of who was in each index or sector.
//
// Every historical quarter this app aggregates is computed over TODAY'S
// constituents, which flatters it: companies that were dropped from an index
// never appear, and the ones that survived are the ones that did well. That is
// survivorship bias, and it cannot be undone retroactively — NSE does not
// publish clean historical membership, and reconstructing it from press
// releases is its own error-prone project.
//
// What CAN be done is stop the bias growing. From the day this table starts
// filling, membership is known point-in-time, so analysis of future quarters is
// honest even though analysis of past ones stays labelled.
//
// Same reasoning as consensus_snapshots, and the same conclusion: start
// recording before anything reads it.
require('dotenv').config({ path: __dirname + '/../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- Who was in the index, on the day we looked
create table if not exists index_membership_snapshots (
  market     text not null,        -- 'IN' | 'US'
  index_key  text not null,        -- 'NSE:NIFTY PHARMA' | 'SPY' | 'SP500'
  snap_date  date not null,
  symbol     text not null,
  name       text,
  fetched_at timestamptz not null default now(),
  primary key (market, index_key, snap_date, symbol)
);
create index if not exists index_membership_asof_idx
  on index_membership_snapshots (market, index_key, snap_date desc);
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
  const { error } = await supabase.from('index_membership_snapshots').select('symbol').limit(1);
  if (error) {
    console.log(`❌ index_membership_snapshots: NOT reachable — ${error.message}`);
    console.log('   → Paste the SQL above into the Supabase SQL editor, then re-run.');
    process.exitCode = 1;
  } else {
    console.log('✓ index_membership_snapshots: reachable');
    console.log('   → Fills daily from dailyJobs. Past quarters stay survivorship-labelled;');
    console.log('     quarters from here forward become genuinely point-in-time.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
