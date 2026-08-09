// Run once: node migrate_macro_monitor.js
//
// Tables for the Macro Decision Monitor.
//
// The important design choice is in macro_observations: the primary key
// includes `vintage_date`, so a revision INSERTS a row rather than overwriting
// one. That is not tidiness — it is the difference between a feature that can
// be validated and one that cannot:
//
//   · Payrolls are revised in each of the next two releases and again at the
//     annual QCEW benchmark, which has moved by more than 500k.
//   · Core PCE is revised most months.
//   · The seasonally-adjusted CPI and unemployment series are revised every
//     February when seasonal factors are re-estimated, so a value stored six
//     months ago can change with no new observation arriving.
//
// A backtest that reads today's revised numbers is reading data the signal
// could not have seen, which is exactly the flattery CLAUDE.md warns about in
// picks/backtest.js. Keeping vintages means the regime can be reconstructed as
// it would have been known at the time.
//
// To keep that from exploding, ingest writes a new vintage row ONLY when the
// value actually changed (see macro/ingest.js). An unrevised daily oil series
// therefore stays one row per date.
//
// macro_signal_snapshots is the recorded-evidence table, written daily by
// dailyJobs.js before the outcome exists — the same standard as
// stock_pick_snapshots, and the only kind of evidence that is not a
// reconstruction.
//
// Release dates reuse the existing `macro_events` table (migrate_macro_events.js)
// rather than adding a second calendar that can drift out of step with it.
//
// Supabase's JS client can't run DDL, so this prints the SQL for the editor and
// then verifies the tables are reachable.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- What each series is, mirrored from backend/macro/series.js so the database
-- is self-describing and joins can carry a label and a unit.
create table if not exists macro_series (
  series_id        text primary key,
  series_key       text not null,
  label            text not null,
  original_source  text not null,
  frequency        text not null,
  unit             text not null,
  transform        text not null,
  release_lag_days int,
  revision_risk    text,
  scored           boolean not null default true,
  note             text,
  updated_at       timestamptz default now()
);

-- One row per (series, observation date, VINTAGE). A revision adds a row; it
-- never replaces one, so history stays reconstructible.
create table if not exists macro_observations (
  series_id        text not null references macro_series(series_id),
  observation_date date not null,
  vintage_date     date not null,
  value            numeric,
  ingested_at      timestamptz not null default now(),
  source           text not null default 'FRED',
  raw              jsonb,
  primary key (series_id, observation_date, vintage_date)
);
create index if not exists macro_obs_series_date on macro_observations (series_id, observation_date desc);
create index if not exists macro_obs_vintage on macro_observations (series_id, vintage_date desc);

-- The latest known value per observation date: what the dashboard reads.
-- An as-of read for a backtest is the same query with
-- "where vintage_date <= :as_of" added before the distinct.
create or replace view macro_observations_latest as
select distinct on (series_id, observation_date)
  series_id, observation_date, vintage_date, value, ingested_at, source
from macro_observations
order by series_id, observation_date, vintage_date desc;

-- The regime as published, written before the outcome existed. This is the
-- table that makes the monitor falsifiable.
create table if not exists macro_signal_snapshots (
  snap_date        date primary key,
  composite_score  numeric,
  regime           text,
  bias             text,
  confidence_level text,
  confidence_score numeric,
  coverage         numeric,
  signals          jsonb not null,
  metrics          jsonb not null,
  thresholds       jsonb not null,
  created_at       timestamptz not null default now()
);
create index if not exists macro_snap_regime on macro_signal_snapshots (regime, snap_date desc);
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
  for (const [table, col] of [
    ['macro_series', 'series_id'],
    ['macro_observations', 'series_id'],
    ['macro_signal_snapshots', 'snap_date'],
  ]) {
    const { error } = await supabase.from(table).select(col).limit(1);
    console.log(error ? `❌ ${table}: NOT reachable — ${error.message}` : `✓ ${table}: reachable`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
