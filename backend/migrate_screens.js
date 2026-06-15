// Run once: node migrate_screens.js
//
// Saved screener definitions. Supabase's JS client can't run DDL, so this
// prints the CREATE TABLE statement for you to paste into the Supabase SQL
// editor, then verifies the table is reachable.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- Custom screener saved definitions
-- NOTE: this table already existed in this project's Supabase with `+'`rules`'+`/
-- `+'`universe`'+` columns, so the backend maps the API shape onto them:
--   rules    jsonb  not null  -- { conditions: [{ field, op, value }, ...] } — ANDed
--   universe text   not null  -- JSON string: { type: 'holdings'|'sector'|'theme', sectorKey?, themeId? }
create table if not exists saved_screens (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  rules       jsonb not null,
  universe    text not null,
  created_at  timestamptz default now()
);
create index if not exists idx_saved_screens_created on saved_screens(created_at desc);
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

  const { error } = await supabase.from('saved_screens').select('id').limit(1);
  if (error) {
    console.log(`❌ saved_screens: NOT reachable — ${error.message}`);
    console.log('   → Paste the SQL above into the Supabase SQL editor, then re-run.');
  } else {
    console.log('✓ saved_screens: reachable');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
