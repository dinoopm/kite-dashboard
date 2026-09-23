// ─── FOMC decisions, and the panel's record against them ─────────────────────
//
// The Macro Decision Monitor prints a policy interpretation — cut-compatible,
// hold-compatible, hike-risk — and until now nothing checked it. On 2026-09-16
// the FOMC raised 25bp to 3.75-4.00% while the panel read hold-compatible, and
// the only reason anyone could say so is that dailyJobs had written that day's
// snapshot at 09:10 UTC, nearly nine hours before the 18:00 announcement.
//
// That is the whole standard here: a bias counts only if it was recorded before
// the outcome existed. This module never reconstructs a past bias from today's
// data — the registry entry for `us_macro_regime` explains why (revised series
// plus a detector that would be fitted with hindsight), and a reconstruction
// would be a weaker kind of evidence quietly pooled with a stronger one.
//
// What it does instead:
//   · derives each meeting's decision from DFEDTARU, which is not revised
//   · pairs it with the snapshot bias that predates the announcement
//   · counts, and REFUSES TO QUOTE A RATE until enough meetings have resolved
//
// Eight meetings a year means the sample floor is roughly two and a half years
// away. Saying so is the point: the panel has one resolved meeting, and one
// meeting is not evidence about anything.

const MIN_RESOLVED = 20;

// How many calendar days after a meeting the new target range must appear in
// DFEDTARU. The change is effective the day after the announcement, so the
// value ON the meeting date is still the old range — reading that would score
// every decision as a hold.
const SETTLE_DAYS = 3;

const DAY_MS = 86400000;
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const iso = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * When a decision is announced, in UTC: 14:00 Eastern on the second day of the
 * meeting. Eastern is UTC-4 from March to November and UTC-5 otherwise;
 * approximating the DST boundary by month is enough, because being an hour out
 * only matters within an hour of the announcement.
 */
function announcedAtUtc(meetingDate) {
  if (!meetingDate) return null;
  const month = Number(String(meetingDate).slice(5, 7));
  const etOffset = month >= 3 && month <= 11 ? 4 : 5;
  return Date.parse(`${String(meetingDate).slice(0, 10)}T00:00:00Z`) + (14 + etOffset) * 3600000;
}

/**
 * One decision per meeting, read from the target range either side of it.
 *
 * A meeting the series does not yet cover past its own date is left OUT rather
 * than called a hold — an unpublished outcome is unresolved, and scoring it as
 * "no change" would hand the panel a free correct answer for every meeting that
 * has just happened.
 */
function decisionsFromMeetings(meetingDates, targetRows, { settleDays = SETTLE_DAYS } = {}) {
  const rows = (targetRows || [])
    .map(r => ({ date: String(r.observation_date ?? r.date).slice(0, 10), value: num(r.value) }))
    .filter(r => r.value != null)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!rows.length) return [];

  const lastAtOrBefore = (day) => {
    let hit = null;
    for (const r of rows) { if (r.date <= day) hit = r; else break; }
    return hit;
  };

  const out = [];
  for (const meetingDate of (meetingDates || []).map(d => String(d).slice(0, 10)).sort()) {
    const before = lastAtOrBefore(meetingDate);
    const after = lastAtOrBefore(iso(Date.parse(`${meetingDate}T00:00:00Z`) + settleDays * DAY_MS));
    // `after` must actually sit past the meeting, or the series simply has not
    // reached this decision yet.
    if (!before || !after || after.date <= meetingDate) continue;

    const bps = Math.round((after.value - before.value) * 100);
    out.push({
      meetingDate,
      decision: bps > 0 ? 'hike' : bps < 0 ? 'cut' : 'hold',
      bps,
      targetUpperBefore: before.value,
      targetUpperAfter: after.value,
      effectiveDate: after.date,
      announcedAt: new Date(announcedAtUtc(meetingDate)).toISOString(),
    });
  }
  return out;
}

/** Each bias claims exactly one decision. Anything else is a miss, not a draw. */
const BIAS_DECISION = { 'cut-compatible': 'cut', 'hold-compatible': 'hold', 'hike-risk': 'hike' };
function biasMatches(bias, decision) {
  return BIAS_DECISION[bias] != null && BIAS_DECISION[bias] === decision;
}

/**
 * The record: decisions against the bias that was on the board before each one.
 *
 * Every entry says which snapshot it used and how old it was, so a reader can
 * see when the panel is being judged on a bias from days earlier rather than
 * from the morning of the meeting.
 */
function scoreDecisions(decisions, snapshots) {
  const snaps = (snapshots || [])
    .map(s => ({
      date: String(s.snap_date).slice(0, 10),
      bias: s.bias ?? null,
      score: num(s.composite_score),
      createdMs: s.created_at ? Date.parse(s.created_at) : null,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdMs ?? 0) - (b.createdMs ?? 0)));

  const entries = (decisions || []).map(d => {
    const announced = announcedAtUtc(d.meetingDate);
    const onOrBefore = snaps.filter(s => s.date <= d.meetingDate);
    // A snapshot written after the announcement knows the answer. Excluded, and
    // named as excluded rather than silently skipped.
    const usable = onOrBefore.filter(s => s.createdMs == null || s.createdMs < announced);
    const chosen = usable.length ? usable[usable.length - 1] : null;

    if (!chosen) {
      return {
        ...d,
        bias: null, biasDate: null, biasScore: null, staleByDays: null, hit: null,
        reason: onOrBefore.length
          ? 'the only snapshot covering this meeting was written after the announcement'
          : 'no bias was recorded before this meeting',
      };
    }
    return {
      ...d,
      bias: chosen.bias,
      biasDate: chosen.date,
      biasScore: chosen.score,
      staleByDays: Math.round((Date.parse(`${d.meetingDate}T00:00:00Z`) - Date.parse(`${chosen.date}T00:00:00Z`)) / DAY_MS),
      hit: biasMatches(chosen.bias, d.decision),
      reason: null,
    };
  });

  const scored = entries.filter(e => e.bias != null);
  const hits = scored.filter(e => e.hit).length;
  const byDecision = { hike: { n: 0, hits: 0 }, hold: { n: 0, hits: 0 }, cut: { n: 0, hits: 0 } };
  for (const e of scored) {
    const b = byDecision[e.decision];
    if (!b) continue;
    b.n += 1;
    if (e.hit) b.hits += 1;
  }

  const resolved = scored.length;
  const tooFew = resolved < MIN_RESOLVED;
  return {
    entries,
    resolved,
    hits,
    unscored: entries.length - resolved,
    byDecision,
    // Below the floor there is no rate, not a rate with a caveat attached. One
    // hit in two meetings is 50%, and rendering that is how a dashboard talks
    // someone into trusting a coin flip.
    hitRate: tooFew ? null : hits / resolved,
    tooFew,
    minResolved: MIN_RESOLVED,
    verdict: tooFew
      ? `${hits} of ${resolved} — too few to judge (needs ${MIN_RESOLVED})`
      : `${hits} of ${resolved} — ${((hits / resolved) * 100).toFixed(0)}% of decisions matched the bias on the board`,
    // Holds are the easy ones: a panel that always says hold-compatible scores
    // every hold for free, so the split matters more than the headline.
    note: 'Holds are the majority of FOMC outcomes, so a bias stuck on hold-compatible collects them for free — read the split by decision, not the total.',
  };
}

/**
 * Meetings that have been announced but whose outcome the rate series has not
 * caught up with.
 *
 * On the evening of 2026-09-16 the Fed had raised and DFEDTARU still read 3.75,
 * because the new range takes effect the next day. "Awaiting data" is a third
 * state next to hit and miss, and collapsing it into either would be a lie in
 * one direction or the other — so these rows carry the claim that is waiting to
 * be judged, and no decision and no hit.
 */
function pendingMeetings(meetingDates, decisions, snapshots, nowMs = Date.now()) {
  const settled = new Set((decisions || []).map(d => d.meetingDate));
  const announced = (meetingDates || [])
    .map(d => String(d).slice(0, 10))
    .filter(d => !settled.has(d) && announcedAtUtc(d) <= nowMs);
  if (!announced.length) return [];

  // Reuse the pairing rule rather than restating it: the bias must still be one
  // recorded before the announcement, exactly as for a scored meeting.
  return scoreDecisions(announced.map(meetingDate => ({ meetingDate })), snapshots)
    .entries.map(({ hit, decision, ...rest }) => rest);
}

module.exports = {
  MIN_RESOLVED, SETTLE_DAYS,
  announcedAtUtc, decisionsFromMeetings, biasMatches, scoreDecisions, pendingMeetings,
};
