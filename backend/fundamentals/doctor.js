// Run: node backend/fundamentals/doctor.js [SYMBOL]
//
// Isolates WHICH stage of the fundamentals ingest is failing, rather than
// leaving "no rows appeared" to be guessed at. Each stage prints what it found
// and stops at the first one that breaks, because every later stage depends on
// it and their errors would be noise.
//
// Writes exactly one probe row and deletes it again, so it proves the write
// path works without leaving anything behind.

require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { fetchScreenerHTML } = require('../screener/fetchHtml');
const { parseScreenerQuarterly, parseScreenerAnnualPL, pickScreenerBasis } = require('../screener/screenerParse');
const { indiaRows } = require('./ingest');

const PROBE_SYMBOL = '__DOCTOR_PROBE__';
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.log(`  ✗ ${m}`); process.exitCode = 1; };

async function main() {
  const symbol = (process.argv[2] || 'TATAPOWER').toUpperCase();
  console.log(`\nfundamentals doctor — probing with ${symbol}\n`);

  // ── 1. Credentials ────────────────────────────────────────────────────────
  console.log('1. Credentials');
  const envPath = path.resolve(__dirname, '../../.env');
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'].filter(k => !process.env[k]);
  if (missing.length) {
    bad(`${missing.join(' and ')} not set. Looked for .env at ${envPath}`);
    return;
  }
  ok(`SUPABASE_URL and SUPABASE_SERVICE_KEY present (.env at ${envPath})`);
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // ── 2. The universe the ingest walks ──────────────────────────────────────
  // An empty list here produces "0 rows from 0 symbols" and no errors at all,
  // which is the most confusing way this can fail.
  console.log('\n2. Universe (sector_constituents)');
  const { data: cons, error: consErr } = await db
    .from('sector_constituents').select('symbol,sector_key');
  if (consErr) { bad(`unreadable: ${consErr.message}`); return; }
  const uniq = new Set((cons || []).map(r => r.symbol));
  if (!uniq.size) {
    bad('0 constituents. The ingest would walk an empty list, save nothing, and report no errors.');
    return;
  }
  ok(`${cons.length} rows, ${uniq.size} unique symbols, ${new Set(cons.map(r => r.sector_key)).size} sectors`);

  // ── 3. The destination table ──────────────────────────────────────────────
  console.log('\n3. Destination table (stock_fundamentals)');
  const { count, error: tblErr } = await db
    .from('stock_fundamentals').select('symbol', { count: 'exact', head: true });
  if (tblErr) { bad(`unreachable: ${tblErr.message}`); return; }
  ok(`reachable, currently holds ${count} row(s)`);

  // ── 4. Can this client actually write to it? ──────────────────────────────
  console.log('\n4. Write path');
  const probe = {
    market: 'IN', symbol: PROBE_SYMBOL, period_type: 'quarter', period_end: '1990-01-31',
    net_profit: 1, unit: 'INR_CR', source: 'doctor', is_financial: false, backfilled: true,
  };
  const { error: wErr } = await db.from('stock_fundamentals')
    .upsert(probe, { onConflict: 'market,symbol,period_type,period_end' });
  if (wErr) {
    bad(`write refused: ${wErr.message}`);
    console.log('     If this mentions row-level security, the service key is not being used,');
    console.log('     or RLS was enabled on the table without a policy for it.');
    return;
  }
  const { data: readBack } = await db.from('stock_fundamentals')
    .select('symbol,first_seen_at').eq('symbol', PROBE_SYMBOL);
  if (!readBack?.length) { bad('write reported success but the row is not readable'); return; }
  await db.from('stock_fundamentals').delete().eq('symbol', PROBE_SYMBOL);
  ok('wrote, read back and cleaned up a probe row');

  // ── 5. The source ─────────────────────────────────────────────────────────
  console.log(`\n5. screener.in fetch (${symbol})`);
  let quarters, basis, annuals = [];
  try {
    const picked = await pickScreenerBasis(symbol, {
      consolidated: true, parse: parseScreenerQuarterly,
      latestOf: (qs) => Math.max(...qs.map(q => q.sortKey)),
      fetchHtml: fetchScreenerHTML, tag: 'doctor',
    });
    quarters = picked.rows; basis = picked.basis;
    ok(`${quarters.length} quarters parsed (${basis} basis)`);
  } catch (err) {
    bad(`fetch or parse failed: ${err.message}`);
    console.log('     A 403 here is screener.in refusing the client, not a bug in the parse.');
    return;
  }
  try {
    const { html } = await fetchScreenerHTML(symbol, { consolidated: basis === 'consolidated' });
    annuals = parseScreenerAnnualPL(html);
    ok(`${annuals.length} fiscal years parsed`);
  } catch (err) {
    console.log(`  · no annual P&L (${err.message}) — quarters alone are still usable`);
  }

  // ── 6. What would actually be stored ──────────────────────────────────────
  console.log('\n6. Mapping to stored rows');
  const rows = indiaRows(symbol, { quarters, annuals, basis }, { backfill: true });
  if (!rows.length) {
    bad('parsed data produced ZERO rows — every column was missing its month/year header');
    return;
  }
  ok(`${rows.length} rows would be written`);
  console.log(`     newest: ${JSON.stringify(
    (({ period_end, label, net_profit, eps, unit, basis: b, is_financial }) =>
      ({ period_end, label, net_profit, eps, unit, basis: b, is_financial }))(
        rows.filter(r => r.period_type === 'quarter').sort((a, b2) => b2.period_end.localeCompare(a.period_end))[0]))}`);
  if (rows.some(r => 'first_seen_at' in r)) {
    bad('a row carries first_seen_at — the upsert would overwrite the vintage on every run');
  } else {
    ok('no row carries first_seen_at, so the column default is left to fire on INSERT only');
  }

  console.log('\nAll stages passed. If a real run still writes nothing, paste its stdout.\n');
}

main().catch(err => { console.error('\nunexpected:', err.message); process.exit(1); });
