// Run once: node migrate_bhav_factors_fn.js
//
// Per-symbol factor inputs from the daily bhavcopy, trailing 60 sessions as-of
// a date (no lookahead — safe for backtesting): true skip-week momentum,
// volume vs own baseline, delivery stats, circuit-days, turnover. Replaces
// picks_delivery_stats as the engine's bhavcopy source (the old function can
// stay; nothing calls it anymore — `drop function picks_delivery_stats(date,date);`
// to tidy up). Paste the SQL into the Supabase SQL editor; this script verifies.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- Trailing-60-session factor inputs per EQ symbol, as of p_to (backtest-safe)
create or replace function picks_bhav_factors(p_to date)
returns table (
  symbol text,
  sessions int,
  close_last numeric,        -- latest close ≤ p_to
  close_skip numeric,        -- 6th-most-recent close (~1 week back)
  close_m20 numeric,         -- 21st-most-recent close (~1 month back)
  ret_20_5 numeric,          -- skip-week momentum: close_skip / close_m20 - 1
  vol_recent5 numeric,       -- avg volume, last 5 sessions
  vol_prior numeric,         -- avg volume, sessions 6-20 (own baseline)
  avg_deliv numeric,         -- mean delivery %, last 20 sessions
  deliv_recent numeric,      -- mean delivery %, last 5
  deliv_prior numeric,       -- mean delivery %, sessions 6-20
  circuit_days int,          -- last 15 sessions closing locked at the high, +4.5%+
  avg_turnover_lacs numeric  -- last 20 sessions
) language sql stable as $fn$
  with base as (
    select symbol, close, high, prev_close, deliv_per, volume, turnover_lacs,
           row_number() over (partition by symbol order by trade_date desc) rn
    from nse_bhavcopy
    where trade_date <= p_to
      and trade_date > p_to - interval '130 days'
      and series = 'EQ'
  ), recent as (
    select * from base where rn <= 60
  )
  select
    symbol,
    count(*)::int,
    (array_agg(close order by rn asc))[1],
    (array_agg(close order by rn asc))[6],
    (array_agg(close order by rn asc))[21],
    case when (array_agg(close order by rn asc))[21] > 0
         and (array_agg(close order by rn asc))[6] is not null
      then round(((array_agg(close order by rn asc))[6]
                / (array_agg(close order by rn asc))[21] - 1), 4)
    end,
    round(avg(volume) filter (where rn <= 5), 0),
    round(avg(volume) filter (where rn between 6 and 20), 0),
    round(avg(deliv_per) filter (where rn <= 20), 1),
    round(avg(deliv_per) filter (where rn <= 5), 1),
    round(avg(deliv_per) filter (where rn between 6 and 20), 1),
    (count(*) filter (
      where rn <= 15 and high > 0 and close >= high * 0.999
        and prev_close > 0 and (close - prev_close) / prev_close >= 0.045
    ))::int,
    round(avg(turnover_lacs) filter (where rn <= 20), 1)
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
    .rpc('picks_bhav_factors', { p_to: '2026-07-01' })
    .range(0, 2);
  if (error) {
    console.log(`❌ picks_bhav_factors: NOT working — ${error.message}`);
    console.log('   → Paste the SQL above into the Supabase SQL editor, then re-run.');
  } else {
    console.log('✓ picks_bhav_factors: working — sample:', JSON.stringify(data?.[0]));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
