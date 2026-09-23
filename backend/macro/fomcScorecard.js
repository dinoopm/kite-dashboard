// ─── GET /api/macro/fomc-scorecard — the panel's record against the Fed ──────
//
// Fetching half of fomc.js. The arithmetic lives there and is tested; this file
// only gathers the three inputs:
//
//   meetings   macro_events, the "Fed Meeting ... (Day 2)" rows
//   decisions  FRED DFEDTARU, the upper bound of the target range
//   bias       macro_signal_snapshots, written daily by dailyJobs
//
// The decisions are NOT stored. A target-range change is a public fact, never
// revised, and re-derivable exactly from a series this app already reads — so a
// table of them would be a copy, not a record. The thing that needs recording is
// the CLAIM, and that is the snapshot, which is already written before each
// outcome exists.
//
// Meetings before the first snapshot are left out entirely rather than listed as
// unscored: the panel made no claim about them, and a list padded with rows it
// could never have answered makes the sample look larger than it is.

const { createClient } = require('@supabase/supabase-js');
const { fetchMany } = require('./fred');
const { readSeries } = require('./ingest');
const { decisionsFromMeetings, scoreDecisions, pendingMeetings } = require('./fomc');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const MEETING_TITLE = /fed meeting/i;
const MEETING_DAY_2 = /day\s*2/i;

/** The target range's upper bound, from the database if it is there and FRED if not. */
async function targetSeries(since) {
  try {
    const rows = await readSeries('DFEDTARU', since);
    if (rows.length) return rows;
  } catch { /* not in the catalogue — fall through to FRED */ }
  const { series } = await fetchMany(['DFEDTARU'], { start: since });
  return (series.DFEDTARU?.observations || [])
    .filter(o => String(o.value) !== '.')
    .map(o => ({ observation_date: o.observation_date, value: Number(o.value) }));
}

async function buildFomcScorecard() {
  const { data: snapRows, error: snapErr } = await supabase
    .from('macro_signal_snapshots')
    .select('snap_date,bias,composite_score,created_at')
    .order('snap_date', { ascending: true });
  if (snapErr) throw new Error(`macro_signal_snapshots: ${snapErr.message}`);

  const snapshots = snapRows || [];
  if (!snapshots.length) {
    return {
      since: null, resolved: 0, hits: 0, unscored: 0, entries: [], tooFew: true, hitRate: null,
      verdict: 'no bias has been recorded yet', source: 'recorded', asOf: new Date().toISOString(),
    };
  }

  const since = String(snapshots[0].snap_date).slice(0, 10);
  // A month of run-up so the target range either side of the first meeting is
  // covered even when that meeting sits days after the first snapshot.
  const seriesSince = new Date(Date.parse(`${since}T00:00:00Z`) - 31 * 86400000).toISOString().slice(0, 10);

  const [{ data: eventRows, error: evErr }, target] = await Promise.all([
    supabase.from('macro_events').select('event_date,title').gte('event_date', since).order('event_date'),
    targetSeries(seriesSince),
  ]);
  if (evErr) throw new Error(`macro_events: ${evErr.message}`);

  const meetings = (eventRows || [])
    .filter(e => MEETING_TITLE.test(e.title || '') && MEETING_DAY_2.test(e.title || ''))
    .map(e => String(e.event_date).slice(0, 10));

  const decisions = decisionsFromMeetings(meetings, target);
  const scored = scoreDecisions(decisions, snapshots);
  // Announced, but DFEDTARU has not published the new range yet. Held apart
  // from both the hits and the misses until the data arrives.
  const pending = pendingMeetings(meetings, decisions, snapshots);

  return {
    ...scored,
    pending,
    since,
    meetingsKnown: meetings.length,
    // Every row was written before its outcome existed; nothing here is
    // reconstructed, and the two must never be pooled.
    source: 'recorded',
    asOf: new Date().toISOString(),
  };
}

module.exports = { buildFomcScorecard };
