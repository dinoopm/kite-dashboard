// Run once: node migrate_bhavcopy.js
//
// NSE full bhavcopy — daily OHLCV + delivery data for every listed EQ/BE stock
// (~2,000 rows/day), scraped by scraper/bhavcopy.js. Universe-wide price
// history for true momentum, volume baselines, liquidity screens and
// forward-return backtesting. Supabase's JS client can't run DDL, so this
// prints the CREATE TABLE statement for you to paste into the Supabase SQL
// editor, then verifies the table is reachable.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- One row per (day, symbol, series): full NSE cash-market bhavcopy w/ delivery
create table if not exists nse_bhavcopy (
  trade_date     date not null,
  symbol         text not null,
  series         text not null,
  prev_close     numeric,
  open           numeric,
  high           numeric,
  low            numeric,
  last_price     numeric,
  close          numeric,
  avg_price      numeric,
  volume         bigint,
  turnover_lacs  numeric,
  trades         bigint,
  deliv_qty      bigint,
  deliv_per      numeric,
  primary key (trade_date, symbol, series)
);
create index if not exists nse_bhavcopy_symbol_idx on nse_bhavcopy (symbol, trade_date desc);
create index if not exists nse_bhavcopy_date_idx on nse_bhavcopy (trade_date desc);
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

  const { error } = await supabase.from('nse_bhavcopy').select('symbol').limit(1);
  if (error) {
    console.log(`❌ nse_bhavcopy: NOT reachable — ${error.message}`);
    console.log('   → Paste the SQL above into the Supabase SQL editor, then re-run.');
  } else {
    console.log('✓ nse_bhavcopy: reachable — backfill with `node scraper/bhavcopy.js 90`');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
