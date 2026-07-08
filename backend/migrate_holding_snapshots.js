// Run once: node migrate_holding_snapshots.js
//
// Daily per-holding analytic state (score + badges + signal) captured by the
// Morning Briefing so it can report CHANGES ("new red flag on X", "Y's signal
// flipped to AVOID") instead of restating standing facts. One row per holding
// per day; the briefing writes today's row on its first run of the day.
// Supabase's JS client can't run DDL — paste the SQL into the SQL editor.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
create table if not exists holding_state_snapshots (
  snap_date  date not null,
  symbol     text not null,
  score      numeric,
  badge_ids  text,      -- comma-joined badge ids from the portfolio x-ray
  signal     text,      -- technical trade-plan action
  primary key (snap_date, symbol)
);
create index if not exists holding_state_snapshots_symbol on holding_state_snapshots (symbol, snap_date desc);
`;

async function main() {
  console.log('\n=== Run this SQL in your Supabase SQL editor (one-time) ===');
  console.log(DDL);
  console.log('===========================================================\n');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { error } = await supabase.from('holding_state_snapshots').select('snap_date').limit(1);
  console.log(error ? `❌ holding_state_snapshots: NOT reachable — ${error.message}` : '✓ holding_state_snapshots: reachable');
}

main().catch(err => { console.error(err); process.exit(1); });
