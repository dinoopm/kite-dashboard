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
const FUNDAMENTALS_MAX_AGE_HOURS = 20; // results change 4x a year — don't re-scrape on a tick

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

/**
 * Newest date among the reconstructed (price-derived) emissions.
 *
 * One row, not a scan. This is the marker for "have the detectors already seen
 * the latest session?" — recorded rows are excluded because picks and 52-week
 * highs arrive on their own schedule and would mask a missing price signal.
 */
async function latestReconstructedEmission() {
  const { data, error } = await supabase.from('signal_emissions')
    .select('snap_date').eq('source', 'reconstructed')
    .order('snap_date', { ascending: false }).limit(1);
  if (error) throw new Error(`signal_emissions: ${error.message}`);
  return data?.[0]?.snap_date || null;
}

async function picksSnapshotDue() {
  const [bhavLast, snapLast] = await Promise.all([
    latestDate('nse_bhavcopy', 'trade_date'),
    latestDate('stock_pick_snapshots', 'snap_date'),
  ]);
  return { due: snapshotIsDue(bhavLast, snapLast), bhavLast, snapLast };
}

// Injected by server.js, because pulling trades needs the live Kite MCP client
// which lives there. Absent (no server, or MCP down) simply skips the job.
let syncTradesFn = null;
function registerTradeSync(fn) { syncTradesFn = fn; }

// Protective-stop proposals. Injected for the same reason as the trade sync:
// building them needs live holdings, which come from the Kite MCP client in
// server.js. This only ever WRITES PROPOSALS — nothing here can reach the
// broker, and placement stays behind an explicit human click.
let stopProposalsFn = null;
function registerStopProposals(fn) { stopProposalsFn = fn; }

/**
 * One pass of every daily recording job.
 *
 * Deliberately sequential and deliberately tolerant: a failure in one job is
 * logged and the next still runs, because a broken picks snapshot is no reason
 * to also stop recording price signals.
 */
async function runDailyJobs({ force = false } = {}) {
  const out = { ranAt: new Date().toISOString(), picks: null, emissions: null, trades: null, stops: null, macro: null };

  // Trades first, and on EVERY tick rather than once a day. Kite exposes only
  // the CURRENT day's fills, so a day this does not run is a day whose trades
  // are gone from the API for good — recoverable only from a Console tradebook
  // CSV. That asymmetry is why there is no "already done today" check here:
  // the upsert is idempotent on trade_id, so re-running costs one API call and
  // nothing else, while skipping wrongly costs a permanent hole. A day with no
  // trades is indistinguishable from a sync that never happened, so guessing is
  // not an option either.
  if (syncTradesFn) {
    try {
      const r = await syncTradesFn();
      out.trades = r;
      // Quiet unless something actually arrived — this runs every 30 minutes.
      if (r?.synced) console.log(`[daily] trades: ${r.synced} fill(s) synced`);
    } catch (err) {
      out.trades = { error: err.message };
      console.warn('[daily] trade sync failed (will retry next tick):', err.message);
    }
  }

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

  // Emission recording is the expensive job: the price detectors need every
  // symbol's full candle history, which is a ~29 MB read of nse_bhavcopy. At
  // one run per 30-minute tick that is 1.35 GB of egress a DAY — enough to
  // exhaust a 5 GB monthly allowance in under four days, which is exactly what
  // it did. Prices only change once a session, so this now runs when bhavcopy
  // has actually advanced past what has already been recorded, not on a timer.
  try {
    const [bhavLast, emissionLast] = await Promise.all([
      latestDate('nse_bhavcopy', 'trade_date'),
      latestReconstructedEmission(),
    ]);
    if (force || !emissionLast || (bhavLast && emissionLast < bhavLast)) {
      const { recordAll } = require('./signals/record');
      const r = await recordAll({ fromDate: isoMinus(EMISSION_LOOKBACK_DAYS) });
      out.emissions = r;
      const total = r.price.saved + r.picks.saved + r.highs.saved;
      console.log(`[daily] signal emissions: ${total} rows upserted (bhavcopy at ${bhavLast})`);
    } else {
      out.emissions = { skipped: 'no new sessions', bhavLast, emissionLast };
    }
  } catch (err) {
    out.emissions = { error: err.message };
    console.error('[daily] signal recording failed (will retry next tick):', err.message);
  }

  // ── Fundamentals ─────────────────────────────────────────────────────────
  //
  // Three jobs, all DB-decided rather than timer-decided, and two of them
  // recording things nothing displays yet.
  //
  // That is deliberate. Consensus estimates and index membership can only ever
  // be captured FORWARD: Yahoo exposes only today's consensus, and NSE does not
  // publish historical membership, so a quarter that passes unrecorded is
  // unrecoverable. Waiting until the panels are built would cost exactly the
  // months of history that make them worth building — the same mistake
  // stock_pick_snapshots made when it lost 2026-07-16 and 07-17.
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Statements: quarterly data changes four times a year, so this is gated on
    // "nothing fetched recently" rather than run on a tick.
    //
    // The staleness check is PER MARKET. A single global check was wrong the
    // moment a second market existed: India's nightly run would refresh the
    // newest fetched_at in the table and the US would then look fresh forever,
    // so its half of the page would stay permanently empty.
    //
    // And at most ONE market runs per tick, staler first. India is ~239
    // screener.in pages at one a second and the US is ~600 Yahoo fetches;
    // running both in one pass makes a ten-minute job out of two four-minute
    // ones, and the next tick is only 30 minutes away.
    const staleness = {};
    for (const market of ['IN', 'US']) {
      const { data, error } = await supabase
        .from('stock_fundamentals').select('fetched_at')
        .eq('market', market)
        .order('fetched_at', { ascending: false }).limit(1);
      if (error) throw new Error(`stock_fundamentals: ${error.message}`);
      const at = data?.[0]?.fetched_at ? Date.parse(data[0].fetched_at) : 0;
      staleness[market] = (Date.now() - at) / 3600000;
    }
    const due = ['IN', 'US']
      .filter(m => force || staleness[m] >= FUNDAMENTALS_MAX_AGE_HOURS)
      .sort((a, b) => staleness[b] - staleness[a]);

    if (due.length) {
      const market = due[0];
      const { runIngest } = require('./fundamentals/ingest');
      // Never --backfill from the scheduler: that flag marks rows whose
      // first_seen_at is an artefact of bulk loading rather than a report
      // landing, and only the one-off CLI run is entitled to set it.
      const res = await runIngest({ market });
      // The API caches per quarter; new rows are the only thing that can change
      // an answer, so the write is what invalidates rather than a TTL.
      require('./fundamentals/service').invalidateCache();
      out.fundamentals = { [market]: res, deferred: due.slice(1) };
      console.log(`[daily] fundamentals ${market}: ${res.saved} rows from ${res.ok} symbols (${res.failed} failed)`);
    } else {
      out.fundamentals = {
        skipped: Object.entries(staleness)
          .map(([m, h]) => `${m} fetched ${h.toFixed(1)}h ago`).join(', '),
      };
    }

    // Membership: one row per index per symbol per day, so a same-day re-run is
    // an idempotent upsert rather than duplication.
    const { count: memCount, error: memErr } = await supabase
      .from('index_membership_snapshots')
      .select('symbol', { count: 'exact', head: true }).eq('snap_date', today);
    if (memErr) throw new Error(`index_membership_snapshots: ${memErr.message}`);
    if (force || !memCount) {
      const { snapshotAll } = require('./fundamentals/membership');
      out.membership = await snapshotAll(today);
    } else {
      out.membership = { skipped: 'already snapshotted today', rows: memCount };
    }

    // Consensus: only symbols inside a reporting window, which is both the
    // cheap set and the only set where a PRE-announcement consensus exists.
    const { count: conCount, error: conErr } = await supabase
      .from('consensus_snapshots')
      .select('symbol', { count: 'exact', head: true }).eq('snap_date', today);
    if (conErr) throw new Error(`consensus_snapshots: ${conErr.message}`);
    if (force || !conCount) {
      const { snapshotConsensus } = require('./fundamentals/consensus');
      // Both markets every day: the reporting-window filter already cuts this
      // to the symbols about to report, which is both the cheap set and the
      // only set where a PRE-announcement consensus can exist.
      out.consensus = {
        IN: await snapshotConsensus({ market: 'IN' }),
        US: await snapshotConsensus({ market: 'US' }),
      };
    } else {
      out.consensus = { skipped: 'already snapshotted today', rows: conCount };
    }
  } catch (err) {
    out.fundamentals = { ...(out.fundamentals || {}), error: err.message };
    console.error('[daily] fundamentals failed (will retry next tick):', err.message);
  }

  // Once per session, not once per tick. Each run fetches holdings plus a year
  // of daily bars for every one of them — ~26 external requests — and the stop
  // levels are computed from DAILY bars, so 48 runs a day would produce the
  // same answer 47 times. Completion is decided by asking the table whether
  // today already has rows, the same DB-decided pattern as the picks snapshot,
  // so a restart neither redoes the work nor skips it.
  if (stopProposalsFn) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { count, error } = await supabase.from('stop_proposals')
        .select('id', { count: 'exact', head: true }).eq('proposed_on', today);
      if (error) throw new Error(`stop_proposals: ${error.message}`);
      if (!force && count > 0) {
        // Skip this job only — never return early, or a job added after this
        // one would be silently skipped along with it.
        out.stops = { skipped: 'already computed today', proposedOn: today, rows: count };
      } else {
        const r = await stopProposalsFn();
        out.stops = r;
        if (r?.proposed) console.log(`[daily] stop proposals: ${r.proposed} proposed, ${r.breached} breached, ${r.rejected} rejected (${r.rule})`);
      }
    } catch (err) {
      out.stops = { error: err.message };
      console.warn('[daily] stop proposals failed (will retry next tick):', err.message);
    }
  }

  // Macro: ingest the official series, then record today's regime BEFORE the
  // outcome exists — the same standard as the picks snapshot, and the only
  // reason the panel will ever be more than a data display. Completion is
  // decided by asking macro_signal_snapshots whether today has a row, so a
  // restart neither redoes the work nor skips it.
  //
  // Failing softly on a missing table is deliberate: this runs on servers
  // where migrate_macro_monitor.js has not been applied, and the picks
  // recorder must not stop because the macro tables do not exist yet.
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { count, error } = await supabase.from('macro_signal_snapshots')
      .select('snap_date', { count: 'exact', head: true }).eq('snap_date', today);
    if (error) throw new Error(`macro_signal_snapshots: ${error.message}`);
    if (!force && count > 0) {
      out.macro = { skipped: 'already recorded today', snapDate: today };
    } else {
      const { runIngest } = require('./macro/ingest');
      const { buildMonitor, recordSnapshot } = require('./macro/monitor');
      const ingested = await runIngest({ mode: 'recent' });
      const monitor = await buildMonitor();
      const snapDate = await recordSnapshot(monitor);
      out.macro = {
        snapDate, regime: monitor.composite.regime, bias: monitor.composite.bias,
        confidence: monitor.confidence.level, dataPath: monitor.dataPath,
        revisions: ingested.results.reduce((n, r) => n + r.revised, 0),
      };
      console.log(`[daily] macro regime ${snapDate}: ${monitor.composite.regime} (${monitor.composite.bias}), confidence ${monitor.confidence.level}`);
    }
  } catch (err) {
    out.macro = { error: err.message };
    console.warn('[daily] macro monitor failed (will retry next tick):', err.message);
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

module.exports = { startDailyJobs, runDailyJobs, runOnce, registerTradeSync, registerStopProposals, picksSnapshotDue, snapshotIsDue, isoMinus };
