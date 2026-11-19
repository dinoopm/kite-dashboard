// ─── Local backups of everything that cannot be rebuilt ──────────────────────
//
// Supabase is the only copy of most of this app's evidence, and much of it can
// never be fetched again: NSE serves FII/DII flows, movers and deals for the
// latest session only; Kite returns only TODAY's trades; a recorded pick or
// signal is evidence precisely because it was written before the outcome, so
// one "re-recorded" later is not the same thing. stock_pick_snapshots already
// has two days that are gone for good (CLAUDE.md). A deleted row, a bad
// migration or a lapsed project would lose all of it.
//
// So, once a day, the gateway copies those tables to gzipped JSON lines under
// backups/ (git-ignored — trade_log and portfolios are personal). Three kinds:
//
//   full         small or mutable tables, copied whole every run (a few MB in
//                all; the last 14 copies are kept).
//   incremental  append-only tables: only rows created since the last run,
//                read in primary-key order (fetchAllKeyset) so no row is
//                skipped or repeated across pages.
//   keys         signal_emissions rows that were RECONSTRUCTED from prices:
//                their meta carries a ~30 KB input snapshot, and copying it
//                would spend Supabase's transfer allowance on data the
//                detectors can recompute. Their keys are kept, so what fired
//                is still on disk.
//
// Not copied: nse_bhavcopy and nse_52_week_high_low (~270 MB together) — NSE
// publishes both as dated archive files that can be re-downloaded.
//
// Two scopes, because the database layer (auth/database.js) only serves a
// personal table — trades, portfolios, screens, notes — to a signed-in Kite
// account, and only that account's rows:
//   public    market tables, copied by the gateway's daily jobs into backups/
//   private   personal tables, copied by each signed-in session's own daily
//             jobs into backups/users/<account id>/, so one account's backup
//             never reads or holds another's rows.
//
// verify.js reads every file back and checks it against the database.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { fetchAllKeyset } = require('../signals/marketSeries');

const ROOT = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');
const KEEP_FULL = 14;
// Mirrors PRIVATE_TABLES in auth/database.js: the tables it will only serve to
// a signed-in account. A test holds the two lists together.
const PRIVATE = new Set([
  'portfolios', 'portfolio_holdings', 'themes', 'theme_instruments', 'saved_screens',
  'us_baskets', 'us_virtual_portfolios', 'us_screens', 'instrument_notes',
  'backtest_runs', 'trade_log', 'user_events', 'holding_state_snapshots', 'stop_proposals',
  'user_signal_emissions',
]);
const privateRoot = (accountId) => path.join(ROOT, 'users', String(accountId).replace(/[^A-Za-z0-9_-]/g, '_'));

// The specification. `key` is the table's unique key, in index order.
const TABLES = [
  // Append-only, and unrecoverable once the source moves on.
  { table: 'signal_emissions', mode: 'incremental', key: ['signal', 'snap_date', 'symbol'], cols: '*', filter: q => q.eq('source', 'recorded'), as: 'signal_emissions.recorded' },
  { table: 'signal_emissions', mode: 'incremental', key: ['signal', 'snap_date', 'symbol'], cols: 'signal,snap_date,symbol,source,created_at', filter: q => q.neq('source', 'recorded'), as: 'signal_emissions.reconstructed-keys' },
  { table: 'user_signal_emissions', mode: 'incremental', key: ['user_id', 'signal', 'snap_date', 'symbol'] },
  { table: 'stock_pick_snapshots', mode: 'incremental', key: ['snap_date', 'symbol'] },
  { table: 'us_pick_snapshots', mode: 'incremental', key: ['snap_date', 'symbol'] },
  { table: 'trade_log', mode: 'incremental', key: ['trade_id'] },
  { table: 'stop_proposals', mode: 'incremental', key: ['id'] },
  { table: 'top_gainers_losers', mode: 'incremental', key: ['id'] },
  { table: 'large_deals', mode: 'incremental', key: ['id'] },
  { table: 'volume_gainers', mode: 'incremental', key: ['id'] },
  // Small or rewritten in place: whole each time.
  { table: 'fii_dii_activity', mode: 'full', key: ['id'] },
  { table: 'participant_oi', mode: 'full', key: ['id'] },
  { table: 'macro_signal_snapshots', mode: 'full', key: ['snap_date'] },
  { table: 'macro_observations', mode: 'full', key: ['series_id', 'observation_date', 'vintage_date'] },
  { table: 'macro_observations_latest', mode: 'full', key: ['series_id', 'observation_date'] },
  { table: 'macro_series', mode: 'full', key: ['series_id'] },
  { table: 'macro_events', mode: 'full', key: ['event_date', 'title'] },
  { table: 'holding_state_snapshots', mode: 'full', key: ['user_id', 'snap_date', 'symbol'] },
  { table: 'portfolios', mode: 'full', key: ['id'] },
  { table: 'portfolio_holdings', mode: 'full', key: ['id'] },
  { table: 'themes', mode: 'full', key: ['id'] },
  { table: 'theme_instruments', mode: 'full', key: ['id'] },
  { table: 'saved_screens', mode: 'full', key: ['id'] },
  { table: 'us_baskets', mode: 'full', key: ['id'] },
  { table: 'us_screens', mode: 'full', key: ['id'] },
  { table: 'us_virtual_portfolios', mode: 'full', key: ['id'] },
  { table: 'instrument_notes', mode: 'full', key: ['user_id', 'symbol'] },
  { table: 'backtest_runs', mode: 'full', key: ['id'] },
  { table: 'sector_constituents', mode: 'full', key: ['id'] },
  { table: 'surveillance_stocks', mode: 'full', key: ['symbol', 'measure'] },
  { table: 'app_users', mode: 'full', key: ['id'] },
].map(t => ({ cols: '*', ...t, name: t.as || t.table, private: PRIVATE.has(t.table) }));

const MANIFEST = (root) => path.join(root, 'manifest.json');
function readManifest(root = ROOT) {
  try { return JSON.parse(fs.readFileSync(MANIFEST(root), 'utf8')); } catch { return { tables: {} }; }
}
function writeManifest(m, root = ROOT) {
  fs.mkdirSync(root, { recursive: true });
  const tmp = `${MANIFEST(root)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, MANIFEST(root));
}

/** Rows → gzipped JSON lines on disk. Returns { file, rows, bytes, sha256 }. */
function writePart(name, label, rows, root = ROOT) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${label}.jsonl.gz`);
  const gz = zlib.gzipSync(Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')));
  fs.writeFileSync(file, gz);
  return { file: path.relative(root, file), rows: rows.length, bytes: gz.length, sha256: crypto.createHash('sha256').update(gz).digest('hex') };
}

/** Rows newer than the cursor, in key order. The cursor is the newest created_at seen. */
function maxCreated(rows, prev) {
  let m = prev || null;
  for (const r of rows) if (r.created_at && (!m || r.created_at > m)) m = r.created_at;
  return m;
}

/**
 * One table. `fetchRows(spec, { since })` returns the rows; injectable for
 * tests. Never deletes an incremental part; prunes full copies past KEEP_FULL.
 */
async function backupTable(spec, entry, { fetchRows, stamp, takenAt = new Date().toISOString(), root = ROOT }) {
  const e = { mode: spec.mode, parts: [], ...(entry || {}) };
  if (spec.mode === 'full') {
    const rows = await fetchRows(spec, {});
    const part = writePart(spec.name, `full-${stamp}`, rows, root);
    e.parts = [...(e.parts || []), { ...part, at: stamp, takenAt }].slice(-KEEP_FULL);
    for (const old of (entry?.parts || []).slice(0, Math.max(0, (entry?.parts || []).length + 1 - KEEP_FULL))) {
      try { fs.unlinkSync(path.join(root, old.file)); } catch { /* already gone */ }
    }
    e.lastRows = rows.length;
    return { e, rows: rows.length, bytes: part.bytes };
  }
  const since = e.cursor || null;
  const rows = await fetchRows(spec, { since });
  if (!rows.length) return { e, rows: 0, bytes: 0 };
  const part = writePart(spec.name, `inc-${stamp}`, rows, root);
  e.parts = [...(e.parts || []), { ...part, at: stamp, takenAt, since, until: maxCreated(rows, null) }];
  e.cursor = maxCreated(rows, since);
  return { e, rows: rows.length, bytes: part.bytes };
}

function defaultFetch(spec, { since }) {
  return fetchAllKeyset(spec.table, spec.cols, spec.key, (q) => {
    let x = spec.filter ? spec.filter(q) : q;
    if (since) x = x.gt('created_at', since);
    return x;
  });
}

/**
 * Back up every table. Per-table failures are reported, not thrown: one
 * missing table must not stop the others being copied.
 */
async function runBackup({ fetchRows = defaultFetch, now = new Date(), only = null, scope = 'public', root = ROOT } = {}) {
  const stamp = now.toISOString().replace(/[:]/g, '').slice(0, 15) + 'Z';
  const manifest = readManifest(root);
  const inScope = TABLES.filter(t => (scope === 'private') === t.private);
  // Entries for tables outside this scope do not belong in this manifest.
  for (const name of Object.keys(manifest.tables)) if (!inScope.some(t => t.name === name)) delete manifest.tables[name];
  manifest.scope = scope;
  const results = [];
  for (const spec of inScope) {
    if (only && !only.includes(spec.name)) continue;
    try {
      const { e, rows, bytes } = await backupTable(spec, manifest.tables[spec.name], { fetchRows, stamp, takenAt: now.toISOString(), root });
      manifest.tables[spec.name] = { ...e, lastOkAt: now.toISOString() };
      results.push({ table: spec.name, ok: true, rows, bytes });
    } catch (err) {
      manifest.tables[spec.name] = { ...(manifest.tables[spec.name] || { mode: spec.mode, parts: [] }), lastError: err.message, lastErrorAt: now.toISOString() };
      results.push({ table: spec.name, ok: false, error: err.message });
    }
    writeManifest(manifest, root);
  }
  manifest.lastRunAt = now.toISOString();
  manifest.lastRunDate = now.toISOString().slice(0, 10);
  manifest.lastFailed = results.filter(r => !r.ok).map(r => r.table);
  writeManifest(manifest, root);
  const failed = results.filter(r => !r.ok);
  return { ranAt: now.toISOString(), tables: results.length, rows: results.reduce((s, r) => s + (r.rows || 0), 0), bytes: results.reduce((s, r) => s + (r.bytes || 0), 0), failed };
}

/** Once a UTC day, after 23:00 UTC (the evening scrapers have landed), or if a whole day was missed. */
function backupDue(now = new Date(), manifest = readManifest(ROOT)) {
  const today = now.toISOString().slice(0, 10);
  const last = manifest.lastRunDate || null;
  if (last === today) return false;
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  return now.getUTCHours() >= 23 || !last || last < yesterday;
}

module.exports = { runBackup, backupTable, backupDue, readManifest, privateRoot, TABLES, PRIVATE, ROOT, writePart };
