// Run once: node migrate_us_tables.js
//
// Persistence for the US section's user-created data (thematic baskets, virtual
// paper portfolios, saved screens). Supabase's JS client can't run DDL, so this
// prints the CREATE TABLE statements to paste into the Supabase SQL editor, then
// verifies the tables are reachable. A jsonb column holds each entity's payload
// so the shapes match the frontend 1:1.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- US thematic baskets: symbols = ["AAPL","MSFT",...]
create table if not exists us_baskets (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  symbols     jsonb not null default '[]'::jsonb,
  created_at  timestamptz default now()
);

-- US virtual (paper) portfolios: holdings = [{id,symbol,name,avgCost,quantity}]
create table if not exists us_virtual_portfolios (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  holdings    jsonb not null default '[]'::jsonb,
  created_at  timestamptz default now()
);

-- US saved screens: scope = {type,...}, conditions = [{field,op,value}]
create table if not exists us_screens (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  scope       jsonb not null default '{}'::jsonb,
  conditions  jsonb not null default '[]'::jsonb,
  created_at  timestamptz default now()
);
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
  for (const table of ['us_baskets', 'us_virtual_portfolios', 'us_screens']) {
    const { error } = await supabase.from(table).select('id').limit(1);
    if (error) console.log(`❌ ${table}: NOT reachable — ${error.message}\n   → Paste the SQL above into the Supabase SQL editor, then re-run.`);
    else console.log(`✓ ${table}: reachable`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
