// Run once: node migrate_themes.js
//
// Thematic baskets ("themes") persistence. Supabase's JS client can't run DDL,
// so this prints the CREATE TABLE statements for you to paste into the Supabase
// SQL editor, then verifies the tables are reachable. No seed data — themes are
// user-created at runtime.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- Thematic baskets
create table if not exists themes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  sort_order  int  default 0,
  created_at  timestamptz default now()
);

create table if not exists theme_instruments (
  id          uuid primary key default gen_random_uuid(),
  theme_id    uuid not null references themes(id) on delete cascade,
  symbol      text not null,
  name        text,
  isin        text,
  exchange    text default 'NSE',
  sort_order  int  default 0,
  created_at  timestamptz default now(),
  unique (theme_id, symbol)
);
create index if not exists idx_theme_instruments_theme on theme_instruments(theme_id);
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

  for (const table of ['themes', 'theme_instruments']) {
    const { error } = await supabase.from(table).select('id').limit(1);
    if (error) {
      console.log(`❌ ${table}: NOT reachable — ${error.message}`);
      console.log('   → Paste the SQL above into the Supabase SQL editor, then re-run.');
    } else {
      console.log(`✓ ${table}: reachable`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
