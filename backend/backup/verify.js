// ─── Restore check: can the backups actually be read back? ───────────────────
//
// A backup nobody has tried to restore is a hope. This reads every file the
// manifest lists, checks its checksum, de-duplicates rows by the table's key,
// and compares what is on disk with the database:
//
//   incremental  every key in the database created at or before the newest
//                backed-up row must be on disk — a missing one is a gap;
//   full         the latest copy must hold every row the table held, and no
//                fewer (rows added since the copy are expected, not a gap).
//
// It never writes to the database. `restorePlan` goes one step further for a
// single table: it reports which backed-up rows are missing from the live
// table, i.e. exactly what a restore would insert — the dry run of a restore.
// Run it:  node backup/verify.js            (all tables)
//          node backup/verify.js trade_log   (one table, with its restore plan)

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { TABLES, ROOT, readManifest, privateRoot } = require('./backup');

const keyOf = (spec, row) => spec.key.map(k => String(row[k])).join('\u0001');

function readPart(part, { root = ROOT } = {}) {
  const buf = fs.readFileSync(path.join(root, part.file));
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== part.sha256) throw new Error(`${part.file}: checksum mismatch`);
  const text = zlib.gunzipSync(buf).toString('utf8');
  const rows = text ? text.split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  if (rows.length !== part.rows) throw new Error(`${part.file}: ${rows.length} rows, manifest says ${part.rows}`);
  return rows;
}

/** Every row a table's backup holds, de-duplicated by key (latest copy wins). Pure over the files. */
function rowsOnDisk(spec, entry, opts) {
  const parts = entry?.parts || [];
  const use = spec.mode === 'full' ? parts.slice(-1) : parts;
  const map = new Map();
  for (const p of use) for (const r of readPart(p, opts)) map.set(keyOf(spec, r), r);
  return map;
}

/**
 * Compare disk with database keys. `dbKeys` is [{ ...keyCols, created_at }].
 * Pure. Returns { onDisk, inDb, missing, ok }.
 */
function compare(spec, entry, disk, dbKeys) {
  let pool = dbKeys;
  if (spec.mode === 'incremental') {
    const until = entry?.cursor;
    pool = until ? dbKeys.filter(r => !r.created_at || r.created_at <= until) : [];
  } else {
    // Rows created after the copy was taken are expected to be absent.
    const takenAt = entry?.parts?.at(-1)?.takenAt;
    pool = takenAt ? dbKeys.filter(r => !r.created_at || r.created_at <= takenAt) : dbKeys;
  }
  const missing = pool.filter(r => !disk.has(keyOf(spec, r)));
  // An empty comparison proves nothing. The first version of this check read
  // the copy time in the wrong format, filtered every database row out, and
  // reported three full tables as perfect; a backup with rows checked against
  // zero database rows is now a failure, not a pass.
  const vacuous = disk.size > 0 && pool.length === 0;
  return {
    onDisk: disk.size, inDb: pool.length, missing: missing.length,
    sampleMissing: missing.slice(0, 3).map(r => keyOf(spec, r).split('\u0001').join(' / ')),
    ok: missing.length === 0 && !vacuous,
    ...(vacuous ? { error: 'nothing in the database to compare against — check the comparison, not the backup' } : {}),
  };
}

async function dbKeysFor(spec) {
  const { fetchAllKeyset } = require('../signals/marketSeries');
  const hasCreated = !['macro_observations', 'macro_observations_latest', 'macro_series', 'macro_events', 'holding_state_snapshots', 'surveillance_stocks', 'instrument_notes', 'sector_constituents', 'participant_oi'].includes(spec.table);
  const cols = [...new Set([...spec.key, ...(hasCreated ? ['created_at'] : [])])].join(',');
  return fetchAllKeyset(spec.table, cols, spec.key, spec.filter || null);
}

async function verifyAll({ only = null, dbKeys = dbKeysFor, scope = 'public', root = ROOT } = {}) {
  const manifest = readManifest(root);
  const out = [];
  for (const spec of TABLES.filter(t => (scope === 'private') === t.private)) {
    if (only && !only.includes(spec.name)) continue;
    const entry = manifest.tables[spec.name];
    if (!entry?.parts?.length) { out.push({ table: spec.name, ok: false, error: 'no backup yet' }); continue; }
    try {
      const disk = rowsOnDisk(spec, entry, { root });
      out.push({ table: spec.name, ...compare(spec, entry, disk, await dbKeys(spec)) });
    } catch (e) {
      out.push({ table: spec.name, ok: false, error: e.message });
    }
  }
  return { checkedAt: new Date().toISOString(), ok: out.every(r => r.ok), tables: out };
}

/** What a restore of one table would insert: backed-up rows absent from the live table. Read-only. */
async function restorePlan(name, { dbKeys = dbKeysFor, root = ROOT } = {}) {
  const spec = TABLES.find(t => t.name === name);
  if (!spec) throw new Error(`unknown table ${name}`);
  const entry = readManifest(root).tables[name];
  const disk = rowsOnDisk(spec, entry, { root });
  const live = new Set((await dbKeys(spec)).map(r => keyOf(spec, r)));
  const wouldInsert = [...disk.entries()].filter(([k]) => !live.has(k)).map(([, r]) => r);
  return { table: name, onDisk: disk.size, live: live.size, wouldInsert: wouldInsert.length, rows: wouldInsert };
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
  const only = process.argv.slice(2);
  (async () => {
    const r = await verifyAll({ only: only.length ? only : null });
    for (const t of r.tables) console.log(`${t.ok ? 'ok  ' : 'FAIL'} ${t.table.padEnd(38)} ${t.error || `${t.onDisk} on disk, ${t.inDb} in db, ${t.missing} missing${t.sampleMissing?.length ? ` (e.g. ${t.sampleMissing[0]})` : ''}`}`);
    if (only.length === 1) {
      const p = await restorePlan(only[0]);
      console.log(`restore dry run: ${p.wouldInsert} of ${p.onDisk} backed-up rows are absent from the live table and would be inserted.`);
    }
    process.exit(r.ok ? 0 : 1);
  })().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { verifyAll, restorePlan, compare, rowsOnDisk, readPart, keyOf, privateRoot };
