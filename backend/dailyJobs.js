// ─── Daily recording, made reliable ──────────────────────────────────────────
//
// The track record only exists if the recording actually happens, and the
// previous arrangement quietly guaranteed it sometimes would not:
//
//   · it fired lazily on the first /api/stock-picks request of each server-day,
//     so a day nobody opened the page was a day with no record;
//   · it set its "done for today" flag BEFORE knowing whether the write
//     succeeded — "one attempt per server-day, even on failure" — so a single
//     transient Supabase error lost that day permanently;
//   · the flag lived in memory, so a restart could redo work or skip it
//     depending on timing.
//
// stock_pick_snapshots is missing 2026-07-16 and 2026-07-17. Those days are
// gone: a snapshot is a claim made before the outcome was known, and one
// reconstructed today would be a different and much weaker kind of evidence.
// The only fix available is to stop losing future ones.
//
// So: the schedule is time-driven rather than request-driven, and completion is
// decided by querying the database rather than by trusting a flag. Retrying is
// safe because every write is an upsert on its primary key.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const TICK_MS = 30 * 60 * 1000;      // re-check every 30 minutes
const FIRST_TICK_MS = 2 * 60 * 1000; // let the server finish booting first
const EMISSION_LOOKBACK_DAYS = 30;   // re-scan a window, so a missed day heals

const isoMinus = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
};

/** Latest date present in a table, or null. */
async function latestDate(table, col) {
  const { data, error } = await supabase.from(table).select(col)
    .order(col, { ascending: false }).limit(1);
  if (error) throw new Error(`${table}: ${error.message}`);
  return data?.[0]?.[col] || null;
}

/**
 * Has the picks snapshot kept up with the price data?
 *
 * Bhavcopy is the trigger, not the wall clock: a snapshot is only meaningful
 * once the day's closes exist, and asking "is the snapshot as recent as the
 * prices?" is both the correct condition and immune to holidays, weekends and
 * the server's timezone.
 */
function snapshotIsDue(bhavLast, snapLast) {
  if (!bhavLast) return false;   // no prices for any day yet — nothing to snapshot
  if (!snapLast) return true;    // never snapshotted
  return snapLast < bhavLast;
}

async function picksSnapshotDue() {
  const [bhavLast, snapLast] = await Promise.all([
    latestDate('nse_bhavcopy', 'trade_date'),
    latestDate('stock_pick_snapshots', 'snap_date'),
  ]);
  return { due: snapshotIsDue(bhavLast, snapLast), bhavLast, snapLast };
}

/**
 * One pass of every daily recording job.
 *
 * Deliberately sequential and deliberately tolerant: a failure in one job is
 * logged and the next still runs, because a broken picks snapshot is no reason
 * to also stop recording price signals.
 */
async function runDailyJobs({ force = false } = {}) {
  const out = { ranAt: new Date().toISOString(), picks: null, emissions: null };

  try {
    const state = await picksSnapshotDue();
    if (force || state.due) {
      // Required lazily: picks/engine pulls in the whole factor pipeline, and
      // this module is imported at server startup.
      const { buildFactorUniverse, saveDailySnapshot } = require('./picks/engine');
      const universe = await buildFactorUniverse({ from: isoMinus(30), to: isoMinus(1) });
      const r = await saveDailySnapshot(universe);
      out.picks = { ...r, was: state };
      console.log(`[daily] picks snapshot ${r.snapDate}: ${r.saved} rows`);
    } else {
      out.picks = { skipped: 'already current', ...state };
    }
  } catch (err) {
    // No flag is set on failure, so the next tick retries — which is the entire
    // point of the rewrite.
    out.picks = { error: err.message };
    console.error('[daily] picks snapshot failed (will retry next tick):', err.message);
  }

  try {
    const { recordAll } = require('./signals/record');
    const r = await recordAll({ fromDate: isoMinus(EMISSION_LOOKBACK_DAYS) });
    out.emissions = r;
    const total = r.price.saved + r.picks.saved + r.highs.saved;
    console.log(`[daily] signal emissions: ${total} rows upserted over the last ${EMISSION_LOOKBACK_DAYS} days`);
  } catch (err) {
    out.emissions = { error: err.message };
    console.error('[daily] signal recording failed (will retry next tick):', err.message);
  }

  return out;
}

// A single in-flight guard: ticks are 30 minutes apart but a slow factor build
// must never overlap itself.
let running = null;
function runOnce(opts) {
  if (!running) running = runDailyJobs(opts).finally(() => { running = null; });
  return running;
}

/** Start the timer. Returns a stop function, mainly so tests can clean up. */
function startDailyJobs() {
  const first = setTimeout(() => { runOnce().catch(() => {}); }, FIRST_TICK_MS);
  const timer = setInterval(() => { runOnce().catch(() => {}); }, TICK_MS);
  if (timer.unref) timer.unref();
  if (first.unref) first.unref();
  console.log(`[daily] recorder scheduled — first run in ${FIRST_TICK_MS / 60000}min, then every ${TICK_MS / 60000}min`);
  return () => { clearTimeout(first); clearInterval(timer); };
}

module.exports = { startDailyJobs, runDailyJobs, runOnce, picksSnapshotDue, snapshotIsDue, isoMinus };
