// Run once: node migrate_macro_events.js
//
// US macro-economic calendar (FOMC meetings, CPI, jobs report, GDP estimates)
// seeded ~annually by scraper/macro_events.js — these dates are published a
// year ahead by the Fed/BLS/BEA and don't change, so a seed table beats a
// live feed. Supabase's JS client can't run DDL — paste into the SQL editor.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
create table if not exists macro_events (
  event_date  date not null,
  title       text not null,
  detail      text,
  seeded_at   timestamptz default now(),
  primary key (event_date, title)
);
create index if not exists macro_events_date on macro_events (event_date);
`;

async function main() {
  console.log('\n=== Run this SQL in your Supabase SQL editor (one-time) ===');
  console.log(DDL);
  console.log('===========================================================\n');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { error } = await supabase.from('macro_events').select('event_date').limit(1);
  console.log(error ? `❌ macro_events: NOT reachable — ${error.message}` : '✓ macro_events: reachable');
}

main().catch(err => { console.error(err); process.exit(1); });
