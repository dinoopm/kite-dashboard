// ─── Context for the risk-severity panel ─────────────────────────────────────
//
// Everything here DESCRIBES the existing assessment; nothing changes it. It
// lives in its own file deliberately: the rule version is a hash of the whole
// of usRiskSeverity.js, thresholds.ts and classify.js, so any edit to those —
// even a comment — mints a new version and restarts the recorded track record
// from zero. That is how 2026-10-27 ended up with four rule versions and four
// one-row histories. Presentation code must never be able to do that again.
//
// What the page could not say before, and now can:
//
//   waitingOn     which input holds the assessment behind the quote — on a
//                 normal morning it is HY OAS, which FRED publishes a session
//                 late, pinning every input two sessions back
//   tierShares    how often the rule matches no tier at all (MIXED was 60% of
//                 the reconstructed history), so CAUTION is not read as the
//                 usual state of the market
//   recorded      the tier as the RECORDED log has it, for the current rule
//                 version only. The panel used to show a tenure counted off the
//                 reconstructed timeline, beside a live verdict, unlabelled —
//                 the recorded/reconstructed pooling CLAUDE.md forbids
//   provisional   what the same rule says with only VIX swapped for the live
//                 quote. Never recorded: every other input is older
//   validation    why the badge says Unvalidated, in one line

const fs = require('fs/promises');

// Inputs whose absence blocks a session from being assessed, in the order a
// reader thinks about them. SPY is never missing here: the timeline is built
// over SPY sessions, so its absence means the session does not exist yet.
const BLOCKING_INPUTS = [
  ['vix', 'VIX close'],
  ['creditChange21', 'HY OAS'],
  ['rotation', 'SPY/TLT closes'],
];

const finite = Number.isFinite;

/** The input holding the assessment behind the newest session, if any. */
function waitingOn(severity) {
  const series = severity?.timeline?.series || [];
  const later = series.filter(p => p.date > (severity?.asOf || ''));
  if (!later.length) return null;
  // By construction every later session is incomplete; the first one is what
  // stands between the assessment and the present.
  const first = later[0];
  return {
    date: first.date,
    sessionsBehind: later.length,
    // severityAt subtracts an undefined spread, so a missing input arrives as
    // NaN in-process and null once serialised. Both mean absent.
    missing: BLOCKING_INPUTS.filter(([key]) => !finite(first.metrics?.[key])).map(([, label]) => label),
  };
}

/** Each tier as a share of classified sessions in the reconstructed history. */
function tierShares(timeline) {
  const classified = (timeline?.series || []).filter(p => p.state && p.state !== 'INCOMPLETE');
  if (!classified.length) return null;
  const counts = {};
  for (const p of classified) counts[p.state] = (counts[p.state] || 0) + 1;
  const shares = Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, Math.round((n / classified.length) * 1000) / 10]));
  return {
    total: classified.length, counts, shares,
    from: classified[0].date, to: classified.at(-1).date,
    // Always reconstructed — said in the payload so no consumer can mistake it.
    source: timeline?.source || 'reconstructed',
  };
}

const SIGNAL_PREFIX = 'us_risk_severity@';

/**
 * The tier according to the recorded log, current rule version only.
 *
 * An entry with no prior tier is where the LOG began, not where the tier began,
 * so its tenure is a lower bound — `initial` says so. Entries under earlier rule
 * versions are counted but never borrowed: a different rule's history is not
 * this rule's evidence.
 */
function recordedTier(rows, ruleVersion) {
  const mine = (rows || []).filter(r => String(r.signal).startsWith(SIGNAL_PREFIX));
  const versions = new Set(mine.map(r => r.signal.slice(SIGNAL_PREFIX.length)));
  const current = mine
    .filter(r => r.signal === `${SIGNAL_PREFIX}${ruleVersion}`)
    .sort((a, b) => String(a.meta?.capturedAt || a.snap_date).localeCompare(String(b.meta?.capturedAt || b.snap_date)));
  const latest = current.at(-1);
  return {
    tier: latest?.meta?.tier ?? null,
    since: latest?.meta?.asOf ?? null,
    capturedAt: latest?.meta?.capturedAt ?? latest?.snap_date ?? null,
    priorTier: latest?.meta?.priorTier ?? null,
    initial: latest ? latest.meta?.priorTier == null : null,
    entries: current.length,
    transitions: current.filter(r => r.meta?.priorTier != null).length,
    earlierVersions: versions.size - (current.length ? 1 : 0),
  };
}

/** Sessions from `from` to `to`, both inclusive, on the timeline's calendar. */
function sessionsBetween(series, from, to) {
  if (!from || !to) return null;
  return (series || []).filter(p => p.date >= from && p.date <= to).length;
}

/**
 * The same rule with only VIX swapped for the live quote.
 *
 * The comparison runs both sides through the same classifier, so the flag
 * differences are the rule's own and not an artefact of payload shape.
 */
function provisional(severity, vix, classifyFn = defaultClassify) {
  if (!finite(vix) || vix <= 0 || !severity?.metrics) return null;
  const opts = { stale: Boolean(severity.stale) };
  const base = classifyFn(severity.metrics, opts);
  const live = classifyFn({ ...severity.metrics, vix }, opts);
  const on = (r) => new Set((r.flags || []).filter(f => f.triggered === true).map(f => f.id));
  const baseOn = on(base), liveOn = on(live);
  return {
    vix,
    state: live.state,
    changesTier: live.state !== severity.state,
    flagsOn: [...liveOn].filter(id => !baseOn.has(id)),
    flagsOff: [...baseOn].filter(id => !liveOn.has(id)),
    // Every other input is still from here, which is why this is never recorded.
    basis: severity.asOf,
  };
}

function defaultClassify(metrics, opts) {
  return require('../usRiskSeverity').classifySeverity(metrics, opts);
}

/** One line on why the validation badge says what it says. */
function validationStatus(report, ruleVersion) {
  if (!report) return { status: 'missing', reason: 'No offline study has been run for this rule.' };
  const lastRun = report.generatedAt ? String(report.generatedAt).slice(0, 10) : null;
  if (report.ruleVersion !== ruleVersion) {
    return { status: 'other-version', lastRun, reason: 'The last offline study ran against an earlier rule version, so it does not apply to this one.' };
  }
  if (report.status === 'blocked') {
    const reason = report.diagnostic?.vintageAvailable === false
      ? 'Historical HY OAS vintages are unavailable from FRED/ALFRED, so a point-in-time study cannot be run.'
      : (String(report.blocker || '').split('. ')[0] || 'Incomplete point-in-time coverage.');
    return { status: 'blocked', lastRun, reason };
  }
  return { status: report.status, lastRun, reason: null };
}

// ─── Fetching ────────────────────────────────────────────────────────────────

const RECORDED_TTL_MS = 5 * 60_000;
let recordedCache = null; // { rows, at }

async function loadRecordedRows(db) {
  if (recordedCache && Date.now() - recordedCache.at < RECORDED_TTL_MS) return recordedCache.rows;
  const { data, error } = await db.from('signal_emissions').select('signal,snap_date,meta').like('signal', `${SIGNAL_PREFIX}%`);
  if (error) throw new Error(error.message);
  recordedCache = { rows: data || [], at: Date.now() };
  return recordedCache.rows;
}

async function readValidationReport() {
  try {
    const { DEFAULT_REPORT } = require('./validation');
    return JSON.parse(await fs.readFile(process.env.US_RISK_VALIDATION_FILE || DEFAULT_REPORT, 'utf8'));
  } catch { return null; }
}

/** The assessment plus everything the panel needs to describe it honestly. */
async function withContext(severity, { db } = {}) {
  const series = severity?.timeline?.series || [];
  let recorded;
  try {
    const client = db || require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    recorded = recordedTier(await loadRecordedRows(client), severity.ruleVersion);
    recorded.sessions = recorded.since ? sessionsBetween(series, recorded.since, severity.asOf) : null;
  } catch {
    recorded = { error: 'The recorded tier history could not be loaded.' };
  }
  return {
    ...severity,
    context: {
      waitingOn: waitingOn(severity),
      tierShares: tierShares(severity.timeline),
      recorded,
      validation: validationStatus(await readValidationReport(), severity.ruleVersion),
    },
  };
}

module.exports = { waitingOn, tierShares, recordedTier, sessionsBetween, provisional, validationStatus, withContext };
