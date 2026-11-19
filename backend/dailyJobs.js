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

const { createClient } = require('./auth/database');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const TICK_MS = 30 * 60 * 1000;      // re-check every 30 minutes
const FIRST_TICK_MS = 2 * 60 * 1000; // let the server finish booting first
const EMISSION_LOOKBACK_DAYS = 30;   // re-scan a window, so a missed day heals
// See usSnapshotDue: 16:00 ET is 20:00 UTC (EDT) / 21:00 UTC (EST), so this
// clears the close by two hours in summer and one in winter.
const US_CLOSE_SETTLED_UTC_HOUR = 22;

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

/**
 * Is a US picks snapshot due?
 *
 * The SPY bar is the trigger, not a clock. It is due when the newest SPY daily
 * bar is newer than the newest snapshot AND that session has closed — the bar
 * is from a previous UTC day, or it is today and the clock is past the cutoff
 * below. Before that Alpaca serves a partial bar and a snapshot taken from it
 * would record prices nobody could have closed at, which is exactly the kind of
 * permanently wrong row this module exists to prevent.
 *
 * The cutoff is 22:00 UTC rather than 21:00 because 16:00 ET is 20:00 UTC in
 * summer (EDT) but 21:00 UTC in winter (EST). A 21:00 cutoff therefore fires at
 * the literal closing bell for half the year, leaving no room for the closing
 * auction to settle — and the daily job ticks every 30 minutes at an offset set
 * by server start time, so a tick CAN land in that first minute. 22:00 gives two
 * hours in summer and one in winter. Waiting an extra hour costs nothing: the
 * snapshot only has to happen sometime that evening.
 */
function usSnapshotDue(spyLast, snapLast, now = new Date()) {
  if (!spyLast) return false;
  if (snapLast && snapLast >= spyLast) return false;
  const todayUtc = now.toISOString().slice(0, 10);
  if (spyLast < todayUtc) return true;
  return now.getUTCHours() >= US_CLOSE_SETTLED_UTC_HOUR;
}

async function runUsPickSnapshot() {
  const { fetchBarsMulti } = require('./alpacaData');
  const start = new Date(); start.setDate(start.getDate() - 10);
  const spy = (await fetchBarsMulti(['SPY'], start)).SPY || [];
  const spyLast = spy.length ? String(spy[spy.length - 1].date).slice(0, 10) : null;
  const snapLast = await latestDate('us_pick_snapshots', 'snap_date');
  if (!usSnapshotDue(spyLast, snapLast)) return { skipped: 'not due', spyLast, snapLast };
  const { buildUsFactorUniverse, saveDailySnapshot } = require('./usPicks/engine');
  const universe = await buildUsFactorUniverse();
  const r = await saveDailySnapshot(universe);
  // Hand the universe to the route's cache. Required lazily because
  // usPicks/routes pulls in the engine, the scorecard and the backtest, and
  // this module is imported at server startup.
  //
  // Only on the path that was going to build it anyway — the `not due` return
  // above short-circuits first, and warming a cache is not worth 518 Yahoo
  // calls every thirty-minute tick.
  try { require('./usPicks/routes').primeUniverseCache(universe); } catch { /* routes not mounted */ }
  return { ...r, spyLast, was: snapLast };
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

// Injected by server.js so a fresh regime read reaches the route's cache the
// moment it is recorded, instead of waiting out the HTTP TTL.
let primeMacroCacheFn = null;
function registerMacroCachePrime(fn) { primeMacroCacheFn = fn; }

/**
 * Should the macro regime be (re-)recorded on this tick?
 *
 * Two reasons to write: nothing is recorded for today yet, or an ingest just
 * changed a series the composite actually scores — a new print or a revision.
 * The second is what makes a mid-day release visible on the day it lands.
 *
 * Re-recording OVERWRITES the day's row (recordSnapshot upserts on snap_date),
 * which is correct rather than a loss of evidence: the row is still written the
 * day the read was made and long before any forward return exists, and the
 * honest record of a day is the data as it finally stood that day, not the
 * hours-old version that happened to be there when the first tick ran.
 *
 * Only SCORED series count. MICH and the financial series are carried for
 * context and are deliberately not composite inputs, so a change in them does
 * not change the number being recorded and must not trigger a rewrite.
 */
function macroRecordDue(hasSnapshotToday, results, scoredIds) {
  const changed = (results || [])
    .filter(r => scoredIds.includes(r.seriesId) && ((r.inserted || 0) > 0 || (r.revised || 0) > 0))
    .map(r => r.seriesId);
  if (!hasSnapshotToday) return { due: true, changed, reason: 'not recorded yet' };
  if (changed.length) return { due: true, changed, reason: `scored series updated: ${changed.join(', ')}` };
  return { due: false, changed, reason: 'already recorded today, no scored series changed' };
}

// Money-flow regime recording (riskRegime.js → signals/record.recordRiskRegime).
//
// What gets recorded is the last SETTLED US session, computed from daily
// closes, so the answer is the same whenever this runs — the hour is not part
// of the evidence. Nothing is fetched from 13:00 to 21:59 UTC only because no
// new settled session can appear then: it covers the session and the settling
// hour in both EDT (13:30–20:00) and EST (14:30–21:00). If Yahoo has not
// posted a close by the first pass after 22:00, that session is picked up by
// the next pass twelve hours later, still before the following open.
//
// `last` is an in-memory note of the last successful pass, and it is ONLY an
// optimisation — it saves refetching five Yahoo series every 30 minutes all
// night. Correctness never rests on it: the recorder writes transitions only,
// keyed on the session, so a restart that forgets it costs one fetch and an
// upsert that changes nothing. It is set after success, never before.
const REGIME_REFETCH_MS = 12 * 60 * 60 * 1000;
function regimeRecordDue(now = new Date(), last = null) {
  const h = now.getUTCHours();
  if (h >= 13 && h < 22) return { due: false, reason: 'US session open or settling' };
  if (last && now.getTime() - last.at < REGIME_REFETCH_MS) return { due: false, reason: `read ${last.sessionDate} within 12h` };
  return { due: true };
}
let lastRegimeRecord = null;

// RRG rotation recording (rrg/rotation.js → signals/record.recordRrgEntries).
//
// Weekly, not daily: a quadrant entry is a fact about a completed week. The
// window to record one opens when the week's last session has closed (16:15
// in New York on its Friday) and shuts at the next week's opening bell, taken
// as Monday 13:30 UTC — the earlier of the two clock changes, so the window is
// never left open into a session. Inside it the write is "before the outcome
// exists"; outside it, it is not, and the week is left to the reconstruction.
//
// `lastWeek` is an in-memory note that a week was handled, and only an
// optimisation: a week with no entries writes no rows, so the table cannot say
// it was looked at. A restart that forgets it costs one fetch and an upsert
// that changes nothing.
function rrgRecordDue(now = new Date(), lastWeek = null) {
  const { weekComplete, fridayKey } = require('./rrg/series');
  let week = fridayKey(now);
  if (!weekComplete(week, now)) {
    const d = new Date(`${week}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 7);
    week = d.toISOString().slice(0, 10);
  }
  const open = new Date(`${week}T13:30:00Z`); open.setUTCDate(open.getUTCDate() + 3); // the Monday after
  const deadline = open.toISOString();
  if (week === lastWeek) return { due: false, week, deadline, reason: 'week already handled' };
  if (now.getTime() >= open.getTime()) return { due: false, week, deadline, reason: 'past the next open — left to the reconstruction' };
  return { due: true, week, deadline };
}
let lastRrgWeek = null;

async function runRrgRecording(decision) {
  const { fetchBarsMulti } = require('./alpacaData');
  const { entriesForWeek, RULE_VERSION } = require('./rrg/rotation');
  const { resampleToWeekly, weekComplete } = require('./rrg/series');
  const { US_RRG_KEYS, US_RRG_BENCHMARK } = require('./rrg/universe');
  // Three years: a point needs 77 weeks behind it and an entry four more.
  const start = new Date(); start.setFullYear(start.getFullYear() - 3);
  const bars = await fetchBarsMulti([US_RRG_BENCHMARK, ...US_RRG_KEYS], start);
  const bench = bars[US_RRG_BENCHMARK] || [];
  const settled = resampleToWeekly(bench).filter(w => weekComplete(w.date));
  // The week's bars must actually be in the feed. "No entries" and "no data
  // yet" both come back empty, and only the first may mark the week handled.
  if (settled[settled.length - 1]?.date !== decision.week) return { skipped: 'week not in the price feed yet', week: decision.week, handled: false };
  const sectors = Object.fromEntries(US_RRG_KEYS.filter(k => bars[k]?.length).map(k => [k, bars[k]]));
  const entries = entriesForWeek(sectors, bench, decision.week);
  const r = await require('./signals/record').recordRrgEntries(entries, {
    week: decision.week, market: 'US', benchmark: US_RRG_BENCHMARK, ruleVersion: RULE_VERSION, deadline: decision.deadline,
  });
  return { ...r, handled: true, moves: entries.map(e => `${e.symbol} ${e.from}→${e.to}`) };
}

/**
 * One pass of every daily recording job.
 *
 * Deliberately sequential and deliberately tolerant: a failure in one job is
 * logged and the next still runs, because a broken picks snapshot is no reason
 * to also stop recording price signals.
 */
// Short, human summaries of a job's result for the status page. Unknown
// shapes fall back to their keys — the point is "what did it do", not a dump.
function jobSummary(v) {
  if (!v || typeof v !== 'object') return null;
  if (v.skipped) return `skipped: ${v.skipped}`;
  const bits = [];
  for (const k of ['saved', 'synced', 'proposed', 'snapDate', 'week', 'verdict', 'regime', 'sessionDate']) {
    if (v[k] != null) bits.push(`${k} ${v[k]}`);
  }
  return bits.join(', ') || 'ran';
}

/**
 * Leave each job's outcome where the status page can read it (healthLog). The
 * gateway's run only: workers run the private jobs for one account, and their
 * outcomes are that session's business, not the machine's.
 */
function logOutcomes(out) {
  try {
    const { noteOutcome, noteRecord } = require('./healthLog');
    for (const [key, v] of Object.entries(out)) {
      if (key === 'ranAt' || v == null) continue;
      noteOutcome(`job-${key}`, v.error ? { ok: false, error: v.error } : { ok: true, detail: jobSummary(v) });
    }
    noteRecord('tick-daily-jobs', { ranAt: out.ranAt, finishedAt: new Date().toISOString() });
  } catch { /* the jobs matter more than their log */ }
}

async function runDailyJobs({ force = false, privateOnly = false } = {}) {
  const out = await runDailyJobsInner({ force, privateOnly });
  if (!privateOnly) {
    logOutcomes(out);
    // Then look at the whole system and tell someone if anything has newly
    // broken (alerts.js). The gateway's pass only: it runs whether or not
    // anyone is signed in, which is exactly when nobody is looking.
    try {
      const status = await require('./systemStatus').systemStatus();
      out.alerts = await require('./alerts').notifyFromStatus(status);
    } catch (err) { out.alerts = { error: err.message }; }
  }
  return out;
}

async function runDailyJobsInner({ force = false, privateOnly = false } = {}) {
  const out = { ranAt: new Date().toISOString(), picks: null, emissions: null, trades: null, stops: null, macro: null, usPicks: null, riskRegime: null, rrgRotation: null };

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

  if (!privateOnly) {
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

  } // Market recording runs once in the gateway, independent of Kite sessions.

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

  // Personal tables can only be read by a signed-in account (auth/database.js),
  // so each session backs up its own, into backups/users/<account>/.
  if (privateOnly) {
    try {
      const me = require('./auth/identity').getIdentity();
      if (me?.appUserId) {
        const b = require('./backup/backup');
        const root = b.privateRoot(me.appUserId);
        if (!force && !b.backupDue(new Date(), b.readManifest(root))) out.backup = { skipped: 'not due' };
        else {
          const r = await b.runBackup({ scope: 'private', root });
          out.backup = r.failed.length ? { error: `${r.failed.length} table(s) failed: ${r.failed.map(f => `${f.table} (${f.error})`).join('; ')}` } : { saved: r.rows };
        }
      }
    } catch (err) {
      out.backup = { error: err.message };
      console.warn('[daily] personal backup failed (will retry next tick):', err.message);
    }
    return out;
  }

  // Independent of page views; transitions are versioned and insert-only.
  try { out.usRiskSeverity = (await require('./usRiskSeverity').getAndRecordUsRiskSeverity()).recording; }
  catch (err) { out.usRiskSeverity = { error: err.message }; }

  // Money-flow regime: record the verdict when it changes. See regimeRecordDue.
  try {
    const decision = regimeRecordDue(new Date(), lastRegimeRecord);
    if (!force && !decision.due) {
      out.riskRegime = { skipped: decision.reason };
    } else {
      const snapshot = await require('./riskRegime').riskRegime();
      const r = await require('./signals/record').recordRiskRegime(snapshot);
      const settledDate = snapshot.settled?.date || null;
      lastRegimeRecord = { at: Date.now(), sessionDate: settledDate };
      out.riskRegime = { ...r, verdict: snapshot.settled?.label || null, sessionDate: settledDate };
      if (r.saved) console.log(`[daily] money-flow regime ${settledDate}: ${r.priorVerdict || '(first record)'} → ${r.verdict}`);
    }
  } catch (err) {
    out.riskRegime = { error: err.message };
    console.warn('[daily] money-flow regime recording failed (will retry next tick):', err.message);
  }

  // RRG rotation: the entries of the week that just completed. See rrgRecordDue.
  try {
    const decision = rrgRecordDue(new Date(), lastRrgWeek);
    if (!decision.due) {
      out.rrgRotation = { skipped: decision.reason, week: decision.week };
    } else {
      const r = await runRrgRecording(decision);
      if (r.handled) lastRrgWeek = decision.week;
      out.rrgRotation = r;
      if (r.saved) console.log(`[daily] RRG entries ${decision.week}: ${r.saved} recorded (${r.moves.join(', ')})`);
    }
  } catch (err) {
    out.rrgRotation = { error: err.message };
    console.warn('[daily] RRG rotation recording failed (will retry next tick):', err.message);
  }

  // Backups of the market tables that cannot be re-fetched (backup/backup.js).
  // Once a UTC day after 23:00, decided by the backup's own manifest.
  try {
    const b = require('./backup/backup');
    if (!force && !b.backupDue()) out.backup = { skipped: 'not due' };
    else {
      const r = await b.runBackup({ scope: 'public' });
      out.backup = r.failed.length ? { error: `${r.failed.length} table(s) failed: ${r.failed.map(f => `${f.table} (${f.error})`).join('; ')}` } : { saved: r.rows };
      console.log(`[daily] backup: ${r.rows} rows, ${(r.bytes / 1e6).toFixed(1)} MB${r.failed.length ? `, ${r.failed.length} table(s) failed` : ''}`);
    }
  } catch (err) {
    out.backup = { error: err.message };
    console.warn('[daily] backup failed (will retry next tick):', err.message);
  }


  // Macro: ingest the official series on EVERY tick, then record today's regime
  // BEFORE the outcome exists — the same standard as the picks snapshot, and
  // the only reason the panel will ever be more than a data display.
  //
  // The ingest is deliberately NOT behind the "already recorded today" check.
  // It used to be, and that cost a whole day of freshness every time a release
  // landed after midnight UTC: the snapshot is written on the first tick after
  // 00:00 UTC, the jobs report lands at 12:30 UTC, and every later tick then
  // said "already recorded today" and skipped the fetch. On 2026-09-04 the
  // panel showed July payrolls (-23k) all day while FRED was already serving
  // August (+162k) and a revision to July. Twelve series a tick is cheap; a
  // day of showing superseded data on a decision panel is not.
  //
  // Failing softly on a missing table is deliberate: this runs on servers
  // where migrate_macro_monitor.js has not been applied, and the picks
  // recorder must not stop because the macro tables do not exist yet.
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { count, error } = await supabase.from('macro_signal_snapshots')
      .select('snap_date', { count: 'exact', head: true }).eq('snap_date', today);
    if (error) throw new Error(`macro_signal_snapshots: ${error.message}`);

    const { runIngest } = require('./macro/ingest');
    const { SCORED_SERIES } = require('./macro/series');
    const ingested = await runIngest({ mode: 'recent' });
    const decision = macroRecordDue(count > 0, ingested.results, SCORED_SERIES.map(s => s.id));

    if (!force && !decision.due) {
      out.macro = { skipped: decision.reason, snapDate: today };
    } else {
      const { buildMonitor, recordSnapshot } = require('./macro/monitor');
      const monitor = await buildMonitor();
      const snapDate = await recordSnapshot(monitor);
      // Hand the fresh read to the route's cache, or the panel keeps serving
      // the pre-release one until the TTL expires — which is the same staleness
      // this block just fixed, moved one layer out.
      if (primeMacroCacheFn) { try { primeMacroCacheFn(monitor); } catch { /* route not mounted */ } }
      out.macro = {
        snapDate, regime: monitor.composite.regime, bias: monitor.composite.bias,
        confidence: monitor.confidence.level, dataPath: monitor.dataPath,
        revisions: ingested.results.reduce((n, r) => n + r.revised, 0),
        rerecorded: count > 0, changed: decision.changed,
      };
      console.log(`[daily] macro regime ${snapDate}: ${monitor.composite.regime} (${monitor.composite.bias}), confidence ${monitor.confidence.level}${decision.changed.length ? ` — re-recorded after ${decision.changed.join(', ')}` : ''}`);
    }
  } catch (err) {
    out.macro = { error: err.message };
    console.warn('[daily] macro monitor failed (will retry next tick):', err.message);
  }

  // US picks. Same standard as the Indian snapshot — written before the
  // outcome exists, completion decided by the table. Fails softly when the
  // table has not been migrated or Alpaca is not configured.
  try {
    const r = await runUsPickSnapshot();
    out.usPicks = r;
    if (r?.saved) console.log(`[daily] US picks snapshot ${r.snapDate}: ${r.saved} rows`);
  } catch (err) {
    out.usPicks = { error: err.message };
    console.warn('[daily] US picks snapshot failed (will retry next tick):', err.message);
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
function startDailyJobs(options = {}) {
  // The status page needs to know the jobs are scheduled at all, and how often,
  // to tell "not run yet" from "stopped running".
  if (!options.privateOnly) {
    try { require('./healthLog').noteRecord('tick-daily-jobs-scheduled', { startedAt: new Date().toISOString(), tickMs: TICK_MS }); } catch { /* see logOutcomes */ }
  }
  const first = setTimeout(() => { runOnce(options).catch(() => {}); }, FIRST_TICK_MS);
  const timer = setInterval(() => { runOnce(options).catch(() => {}); }, TICK_MS);
  if (timer.unref) timer.unref();
  if (first.unref) first.unref();
  console.log(`[daily] recorder scheduled — first run in ${FIRST_TICK_MS / 60000}min, then every ${TICK_MS / 60000}min`);
  return () => { clearTimeout(first); clearInterval(timer); };
}

module.exports = { startDailyJobs, runDailyJobs, runOnce, registerTradeSync, registerStopProposals, registerMacroCachePrime, picksSnapshotDue, snapshotIsDue, isoMinus, usSnapshotDue, runUsPickSnapshot, macroRecordDue, regimeRecordDue, rrgRecordDue, jobSummary, logOutcomes, TICK_MS };
