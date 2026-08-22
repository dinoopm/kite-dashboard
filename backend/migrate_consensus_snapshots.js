// Run once: node migrate_consensus_snapshots.js
//
// A daily snapshot of what analysts expected, per symbol per forecast period.
//
// This table exists because of a limitation, not a feature: Yahoo exposes only
// the CURRENT consensus. The pre-announcement consensus for a past quarter is
// not recoverable from any source this app can reach — the same shape as
// analyst_target_upside, and the same conclusion. So beat/miss and estimate
// revisions are FORWARD-ONLY: they exist for quarters that report after
// recording begins, and historical quarters show "no pre-announcement consensus
// recorded" rather than a reconstructed one.
//
// Which is why the recording starts now, before anything displays it. Every day
// not recorded is permanently missing — the lesson stock_pick_snapshots taught
// by losing 2026-07-16 and 07-17.
//
// The primary key is keyed on Yahoo's RAW trend period ('0q', '+1q'), and
// trend_end_date is stored beside it, because those labels are relative: '0q'
// means a different quarter before and after a result lands. Resolving a
// snapshot by its label later would silently attach the wrong quarter's
// expectation to a result. Joins go through trend_end_date.
//
// The snapshot selection rule for beat/miss, pinned here so it is not
// relitigated when the panel ships: the consensus for a result is the LATEST
// snapshot whose snap_date is strictly BEFORE that result row's first_seen_at,
// joined on trend_end_date ≈ period_end. Strictly-before is what makes it
// pre-announcement.
//
// One honest caveat to carry into the UI: Yahoo consensus is normalized
// (adjusted) EPS while screener.in reports as-reported EPS. Comparing them
// produces a systematic, one-directional error, so the panel labels the
// comparison rather than implying a clean surprise number.
//
// market_cap rides along because it comes from the SAME
// quoteSummary(['price','earningsTrend']) call — one fetch serves both the
// index weighting and the consensus, which is what makes the nightly cost
// bearable.
require('dotenv').config({ path: __dirname + '/../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- What was expected, as at a given day
create table if not exists consensus_snapshots (
  market          text not null,
  symbol          text not null,
  snap_date       date not null,
  trend_period    text not null,     -- Yahoo's RELATIVE label: '0q', '+1q', '0y'
  trend_end_date  date,              -- what that label meant ON snap_date
  eps_avg         numeric,
  eps_low         numeric,
  eps_high        numeric,
  analysts        int,
  revenue_avg     numeric,
  market_cap      numeric,
  market_cap_unit text,              -- 'INR' | 'USD' — never inferred from market
  fetched_at      timestamptz not null default now(),
  primary key (market, symbol, snap_date, trend_period)
);
create index if not exists consensus_snapshots_lookup_idx
  on consensus_snapshots (market, symbol, trend_end_date, snap_date desc);
create index if not exists consensus_snapshots_cap_idx
  on consensus_snapshots (market, snap_date desc);
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
  const { error } = await supabase.from('consensus_snapshots').select('symbol').limit(1);
  if (error) {
    console.log(`❌ consensus_snapshots: NOT reachable — ${error.message}`);
    console.log('   → Paste the SQL above into the Supabase SQL editor, then re-run.');
    process.exitCode = 1;
  } else {
    console.log('✓ consensus_snapshots: reachable');
    console.log('   → It fills from dailyJobs. Nothing displays it until enough days accumulate,');
    console.log('     which is the point: recording has to start before the panel can exist.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
