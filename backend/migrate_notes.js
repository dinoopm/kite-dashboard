// Run once: node migrate_notes.js
//
// Per-instrument free-text notes. Supabase's JS client can't run DDL, so this
// prints the CREATE TABLE statement for you to paste into the Supabase SQL
// editor, then verifies the table is reachable. No seed data — notes are
// user-created at runtime.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- One free-text note per trading symbol
create table if not exists instrument_notes (
  symbol      text primary key,
  note        text not null default '',
  updated_at  timestamptz default now()
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

  const { error } = await supabase.from('instrument_notes').select('symbol').limit(1);
  if (error) {
    console.log(`❌ instrument_notes: NOT reachable — ${error.message}`);
    console.log('   → Paste the SQL above into the Supabase SQL editor, then re-run.');
  } else {
    console.log('✓ instrument_notes: reachable');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
