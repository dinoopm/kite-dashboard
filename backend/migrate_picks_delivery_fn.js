// Run once: node migrate_picks_delivery_fn.js
//
// Per-symbol delivery-conviction stats over the last ~20 sessions of a window,
// computed in Postgres (aggregating ~55k bhavcopy rows per request through the
// REST API would be far too slow). Feeds the picks engine's delivery-adjusted
// volume authenticity, circuit-ladder flag and distribution ("price up,
// delivery down") flag. Supabase's JS client can't run DDL, so paste the SQL
// into the Supabase SQL editor; this script then verifies the function works.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- Delivery-conviction stats per symbol (EQ series, last 20 sessions of window)
create or replace function picks_delivery_stats(p_from date, p_to date)
returns table (
  symbol text,
  sessions int,
  avg_deliv numeric,          -- mean delivery %, last 20 sessions
  deliv_recent numeric,       -- mean delivery %, last 5 sessions
  deliv_prior numeric,        -- mean delivery %, sessions 6-20
  circuit_days int,           -- last 15 sessions closing locked at the high, +4.5% or more
  price_ref numeric,          -- close ~20 sessions ago
  price_last numeric,         -- latest close
  avg_turnover_lacs numeric
) language sql stable as $fn$
  with base as (
    select symbol, close, high, prev_close, deliv_per, turnover_lacs,
           row_number() over (partition by symbol order by trade_date desc) rn
    from nse_bhavcopy
    where trade_date between p_from and p_to and series = 'EQ'
  ), recent as (
    select * from base where rn <= 20
  )
  select
    symbol,
    count(*)::int,
    round(avg(deliv_per), 1),
    round(avg(deliv_per) filter (where rn <= 5), 1),
    round(avg(deliv_per) filter (where rn between 6 and 20), 1),
    (count(*) filter (
      where rn <= 15 and high > 0 and close >= high * 0.999
        and prev_close > 0 and (close - prev_close) / prev_close >= 0.045
    ))::int,
    (array_agg(close order by rn desc))[1],
    (array_agg(close order by rn asc))[1],
    round(avg(turnover_lacs), 1)
  from recent
  group by symbol
$fn$;
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
  const { data, error } = await supabase
    .rpc('picks_delivery_stats', { p_from: '2026-06-01', p_to: '2026-07-01' })
    .range(0, 4);
  if (error) {
    console.log(`❌ picks_delivery_stats: NOT working — ${error.message}`);
    console.log('   → Paste the SQL above into the Supabase SQL editor, then re-run.');
  } else {
    console.log(`✓ picks_delivery_stats: working — sample:`, JSON.stringify(data?.[0]));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
