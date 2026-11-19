// ─── Outcome log: what ran, when, and whether it worked ──────────────────────
//
// Four failures in one week of November 2026 were each found by looking, not
// by an alert: the Indian scorecard timing out (which hid every Indian badge),
// rule versions forking on unrelated edits, a scraper dying at NSE's front
// door, and two claims the app's own data contradicted. The common thread is
// that the app only ever reported SUCCESS. A job that failed logged a line to
// a terminal nobody watches, and a scorecard that failed made its badges
// quietly disappear.
//
// So every job and scorecard now leaves an outcome here, and the status page
// (systemStatus.js) reads them back. Files, not a table: the writers are the
// gateway (market-wide daily jobs) and every session worker (scorecards), all
// on one machine, and a file needs no migration. One file per name, written
// atomically, so two processes never interleave inside one file.
//
// Never throws. A health log that can break the thing it is watching is worse
// than none.

const fs = require('fs');
const path = require('path');

const DIR = process.env.HEALTH_LOG_DIR || path.join(__dirname, 'data', 'health');
const safe = (name) => String(name).replace(/[^a-z0-9._-]+/gi, '_');
const file = (name) => path.join(DIR, `${safe(name)}.json`);

function readOne(name) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return null; }
}

function writeOne(name, value) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${file(name)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file(name));
  } catch { /* see header: never throws */ }
}

/**
 * Record one run. `ok` false with `error`, or true with an optional `detail`
 * (a short summary of what it did). Keeps the last success and the last
 * failure separately, so "it failed at 03:00 and has worked since" and "it
 * has failed every run since Tuesday" read differently.
 */
function noteOutcome(name, { ok, error = null, detail = null, at = new Date() } = {}) {
  const prev = readOne(name) || { name };
  const iso = new Date(at).toISOString();
  const next = { ...prev, name, lastRunAt: iso, lastOk: Boolean(ok), pid: process.pid };
  if (ok) { next.lastOkAt = iso; next.lastDetail = detail; next.consecutiveFailures = 0; }
  else {
    next.lastErrorAt = iso;
    next.lastError = String(error || 'failed').slice(0, 500);
    next.consecutiveFailures = (prev.consecutiveFailures || 0) + 1;
  }
  writeOne(name, next);
  return next;
}

/** A plain record (process identity, last tick) with no ok/error semantics. */
function noteRecord(name, value) {
  writeOne(name, { name, ...value, writtenAt: new Date().toISOString(), pid: process.pid });
}

/** Every record whose name starts with `prefix`, keyed by name. */
function readAll(prefix = '') {
  const out = {};
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (!f.endsWith('.json') || !f.startsWith(safe(prefix))) continue;
      const v = readOne(f.slice(0, -5));
      if (v?.name) out[v.name] = v;
    }
  } catch { /* no directory yet: nothing has run */ }
  return out;
}

module.exports = { noteOutcome, noteRecord, readOne, readAll, DIR };
