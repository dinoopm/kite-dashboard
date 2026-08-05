// Run once: node migrate_stop_proposals.js
//
// One row per proposed protective stop. This is the audit trail for the only
// part of the app that can ever reach the broker, so it records what was
// PROPOSED as well as what was placed — including proposals that were rejected
// and orders that failed. A log that only holds successes cannot answer "why
// was there no stop on that position?", which is the question that matters
// after a loss.
//
// `status` lifecycle:
//   proposed  — computed and shown, nothing sent
//   breached  — computed fine; the position is ALREADY below its trail, so no
//               order is proposed (placing one would be a market sell)
//   rejected  — could not be computed (no quantity, too little history)
//   placed    — a GTT exists at the broker for it
//   failed    — placement was attempted and the broker refused
//   cancelled — the GTT is gone (cancelled at the broker, or superseded)
//   triggered — the broker reports it fired
//
// Supabase's JS client can't run DDL, so this prints the CREATE TABLE for the
// SQL editor and then verifies the table is reachable.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- Protective-stop proposals and their fate
create table if not exists stop_proposals (
  id               uuid primary key default gen_random_uuid(),
  proposed_on      date not null,
  symbol           text not null,
  exchange         text not null default 'NSE',
  instrument_token bigint,
  quantity         numeric not null,
  trigger_price    numeric,
  last_price       numeric,
  avg_price        numeric,
  rule             text not null,
  worst_case_loss  numeric,
  -- How far the trigger sits below spot, for a proposal.
  distance_pct     numeric,
  -- For a breached position: the trail level price fell through, and by how
  -- much. A breach proposes no order, so it has no trigger_price — these two
  -- carry the finding instead.
  breached_level   numeric,
  below_trail_pct  numeric,
  status           text not null default 'proposed',
  reject_reason    text,
  broker_order_id  text,
  placed_at        timestamptz,
  created_at       timestamptz default now(),
  -- One live proposal per instrument per day. Re-running the daily job updates
  -- rather than piling up duplicates the user would have to read through.
  unique (proposed_on, symbol, exchange)
);
create index if not exists stop_proposals_status_idx on stop_proposals (status, proposed_on desc);
create index if not exists stop_proposals_symbol_idx on stop_proposals (symbol, proposed_on desc);
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
  const { error } = await supabase.from('stop_proposals').select('id').limit(1);
  if (error) {
    console.log(`❌ stop_proposals: NOT reachable — ${error.message}`);
    console.log('   → Paste the SQL above into the Supabase SQL editor, then re-run.');
    process.exitCode = 1;
  } else {
    console.log('✓ stop_proposals: reachable');
    console.log('   → Proposals are computed by the daily job; nothing is ever placed without an explicit click.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
