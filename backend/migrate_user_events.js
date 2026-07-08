// Run once: node migrate_user_events.js
//
// User-added calendar events (AGMs heard about on a call, expected order
// wins, lock-in expiries…) shown alongside the scraped NSE event calendar on
// the Events page, instrument badges and the Morning Briefing. Supabase's JS
// client can't run DDL — paste the SQL into the Supabase SQL editor.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
create table if not exists user_events (
  id          bigint generated always as identity primary key,
  symbol      text not null,
  event_date  date not null,
  title       text not null,
  notes       text,
  created_at  timestamptz default now()
);
create index if not exists user_events_date on user_events (event_date);
`;

async function main() {
  console.log('\n=== Run this SQL in your Supabase SQL editor (one-time) ===');
  console.log(DDL);
  console.log('===========================================================\n');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { error } = await supabase.from('user_events').select('id').limit(1);
  console.log(error ? `❌ user_events: NOT reachable — ${error.message}` : '✓ user_events: reachable');
}

main().catch(err => { console.error(err); process.exit(1); });
