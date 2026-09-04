// Run once: node migrate_us_pick_snapshots.js
//
// Daily default-weight top-25 US quant-pick snapshots — the model's
// out-of-sample track record, written once per US session by dailyJobs (or
// POST /api/us/stock-picks/snapshot). Supabase's JS client can't run DDL, so
// this prints the CREATE TABLE statement for the Supabase SQL editor, then
// verifies the table is reachable. No seed data — history accumulates from the
// first snapshot on.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- One row per (session, symbol): the default-weight top-25 US quant picks that day.
-- Per-factor percentiles are stored so a factor's forward IC can be measured from
-- what was actually recorded — that is how EPS revisions, which cannot be
-- backtested, earns or loses its weight.
create table if not exists us_pick_snapshots (
  snap_date          date    not null,
  symbol             text    not null,
  rank               int     not null,
  composite          numeric,
  momentum_pct       numeric,
  volume_pct         numeric,
  fifty_two_pct      numeric,
  rel_strength_pct   numeric,
  revisions_pct      numeric,
  revisions_raw      numeric,
  trap_risk          boolean default false,
  last_close         numeric,
  created_at         timestamptz default now(),
  primary key (snap_date, symbol)
);
create index if not exists us_pick_snapshots_symbol_idx on us_pick_snapshots (symbol, snap_date desc);
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
  // A real select, not a head/count probe: with `head: true` PostgREST answers
  // a missing table with `count: null` and NO error, so the probe reports every
  // table as reachable — including ones that cannot exist. This is the check
  // migrate_pick_snapshots.js already uses, and the reason it is written this way.
  const { error } = await supabase.from('us_pick_snapshots').select('snap_date').limit(1);
  if (error) console.log(`Not reachable yet: ${error.message}\nPaste the SQL above, then re-run this script.`);
  else console.log('us_pick_snapshots is reachable.');
}
main().catch(err => { console.error(err.message); process.exit(1); });
