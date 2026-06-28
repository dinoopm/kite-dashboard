// Run once: node migrate_portfolios.js
//
// Virtual ("paper") portfolios persistence. Supabase's JS client can't run DDL,
// so this prints the CREATE TABLE statements for you to paste into the Supabase
// SQL editor, then verifies the tables are reachable. No seed data — portfolios
// and their holdings are user-created at runtime.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- Virtual portfolios (a named bucket of hypothetical holdings)
create table if not exists portfolios (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  sort_order  int  default 0,
  created_at  timestamptz default now()
);

create table if not exists portfolio_holdings (
  id            uuid primary key default gen_random_uuid(),
  portfolio_id  uuid not null references portfolios(id) on delete cascade,
  symbol        text not null,
  name          text,
  isin          text,
  exchange      text default 'NSE',
  avg_cost      numeric not null default 0,
  quantity      numeric not null default 0,
  sort_order    int  default 0,
  created_at    timestamptz default now(),
  unique (portfolio_id, symbol)
);
create index if not exists idx_portfolio_holdings_portfolio on portfolio_holdings(portfolio_id);
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

  for (const table of ['portfolios', 'portfolio_holdings']) {
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
