// ─── The Macro Decision Monitor ──────────────────────────────────────────────
//
// Assembles the panel: six-month readings for every series, five sub-signals,
// one composite regime, a confidence level, and the next scheduled release.
//
// Reads from macro_observations when the tables exist (fast, and it uses the
// stored vintages), and falls back to fetching FRED directly when they do not,
// so the feature works before anyone has run migrate_macro_monitor.js. Which
// path ran is reported in `dataPath` rather than hidden — the database path is
// the one whose numbers can be reproduced later.
//
// What this produces is a BIAS from seven series, not a forecast of anything.
// The FOMC weighs financial stability, credit conditions, global growth and
// politics, none of which are inputs here.

const YahooFinance = require('yahoo-finance2').default;
const { createClient } = require('@supabase/supabase-js');
const { SERIES, SCORED_SERIES } = require('./series');
const { computeMetrics, releasesBehind } = require('./calc');
const { buildSignals, THRESHOLDS } = require('./signals');
const { fetchMany, hasApiKey } = require('./fred');
const { readSeries } = require('./ingest');

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Two and a half years: enough for a 12-month comparison plus room for the
// six-month window to land on a valid observation at the far end.
const WINDOW_MONTHS = 30;

const windowStart = () => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - WINDOW_MONTHS);
  return d.toISOString().slice(0, 10);
};

/** Observations per series from the database, or null if that path is unusable. */
async function loadFromDb(since) {
  try {
    const out = {};
    for (const s of SERIES) out[s.id] = await readSeries(s.id, since);
    // An empty table is not a working database path — it is a migration that
    // has not been run, and serving zeros off it would be worse than fetching.
    const total = Object.values(out).reduce((n, rows) => n + rows.length, 0);
    return total > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Observations per series straight from FRED. */
async function loadFromFred(since) {
  const { series, errors } = await fetchMany(SERIES.map(s => s.id), { start: since });
  const out = {};
  for (const s of SERIES) out[s.id] = series[s.id]?.observations || [];
  return { observations: out, errors };
}

/**
 * Live WTI, for freshness only — never for the scored six-month measure.
 *
 * DCOILWTICO is spot at Cushing, settled, and reaches FRED about five days
 * late. CL=F is the front-month futures contract, quoted continuously. They
 * track each other but are DIFFERENT INSTRUMENTS, so running the six-month
 * window on the futures series would bake contract-roll jumps into the rate of
 * change — over six months that is worth more than the lag it would fix.
 *
 * So the score stays on one consistent instrument, and this is shown beside it
 * with `wouldChangeScore` computed honestly: if the live price would move the
 * oil component across a threshold, that is worth knowing, and if it would not
 * — which is the usual case, because the component clamps — then the lag is
 * not costing anything and the panel should say so rather than imply staleness.
 */
async function liveOil(sixMonthsAgoValue) {
  try {
    const q = await yf.quote('CL=F', {}, { validateResult: false });
    const price = q?.regularMarketPrice;
    if (!Number.isFinite(price)) return null;
    const rocPct = sixMonthsAgoValue ? ((price / sixMonthsAgoValue) - 1) * 100 : null;
    return {
      symbol: 'CL=F',
      instrument: 'WTI front-month futures',
      price,
      quotedAt: q.regularMarketTime ? new Date(q.regularMarketTime).toISOString() : null,
      delayMin: q.exchangeDataDelayedBy ?? null,
      rocPct,
    };
  } catch {
    return null;
  }
}

/** The next scheduled macro event, from the existing macro_events calendar. */
async function nextRelease() {
  try {
    const todayIso = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase.from('macro_events')
      .select('event_date,title,detail')
      .gte('event_date', todayIso)
      .order('event_date', { ascending: true })
      .limit(2);
    if (error || !data?.length) return { next: null, following: null };
    const shape = (r) => ({
      date: String(r.event_date).slice(0, 10),
      title: r.title,
      detail: r.detail ?? null,
      daysAway: Math.round((Date.parse(`${String(r.event_date).slice(0, 10)}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86400000),
    });
    return { next: shape(data[0]), following: data[1] ? shape(data[1]) : null };
  } catch {
    return { next: null, following: null };
  }
}

/**
 * Build the whole panel.
 *
 * `anchorDate` exists so a reconstruction can ask what this looked like on a
 * past date without the answer drifting with the wall clock.
 */
async function buildMonitor({ anchorDate = null, preferDb = true } = {}) {
  const since = windowStart();
  let observations = preferDb ? await loadFromDb(since) : null;
  let dataPath = 'database';
  let fetchErrors = {};

  if (!observations) {
    const live = await loadFromFred(since);
    observations = live.observations;
    fetchErrors = live.errors;
    dataPath = 'fred-live';
  }

  // Metrics keyed by the catalogue's short key, which is what signals.js reads.
  const metrics = {};
  const indicators = [];
  for (const s of SERIES) {
    const m = computeMetrics(observations[s.id] || [], {
      frequency: s.frequency,
      transform: s.transform,
      anchorDate,
    });
    // Measured against the release SCHEDULE, not the wall clock — see
    // calc.releasesBehind. Core PCE's newest possible reference month is
    // always ~2 months back, and that is current, not stale.
    m.releasesBehind = releasesBehind(m.latestDate, {
      frequency: s.frequency, releaseLagDays: s.releaseLagDays, anchorDate,
    });
    // Which vintage the LATEST observation came from, so the panel can say
    // "Jun 2026 value, as revised 2026-08-09" instead of leaving the reader to
    // guess whether a figure is a first print or a revision.
    const latestRow = (observations[s.id] || []).filter(o => o.value != null).pop();
    m.vintageDate = latestRow?.vintage_date ?? null;
    metrics[s.key] = { ...m, seriesId: s.id, frequency: s.frequency };
    indicators.push({
      key: s.key,
      seriesId: s.id,
      label: s.label,
      source: s.originalSource,
      frequency: s.frequency,
      unit: s.unit,
      transform: s.transform,
      scored: s.scored !== false,
      revisionRisk: s.revisionRisk,
      note: s.note,
      ...m,
    });
  }

  const { signals, composite, confidence } = buildSignals(metrics);
  const releases = await nextRelease();

  // Live WTI alongside the settled series, so the panel is current on the one
  // input that moves daily. It does NOT feed the score — see liveOil — but it
  // does say whether it would, which is the question worth answering: a lag
  // that cannot change the reading is not a staleness problem.
  const oilIndicator = indicators.find(i => i.seriesId === 'DCOILWTICO');
  const live = await liveOil(oilIndicator?.sixMonthsAgo);
  if (live && oilIndicator) {
    const T = THRESHOLDS.oil;
    const liveScore = live.rocPct == null ? null
      : Math.max(-1, Math.min(1, ((live.rocPct - T.rocCool) / (T.rocHot - T.rocCool)) * 2 - 1));
    const scored = signals.oil?.score;
    live.scoreIfUsed = liveScore;
    live.wouldChangeScore = liveScore != null && scored != null && Math.abs(liveScore - scored) > 0.005;
    oilIndicator.live = live;
    metrics.oil.live = live;
  }

  const staleSeries = indicators
    .filter(i => i.scored && i.releasesBehind != null && i.releasesBehind > 0)
    .map(i => `${i.label} (${i.releasesBehind} release${i.releasesBehind > 1 ? 's' : ''} behind, latest ${i.latestDate})`);

  const missing = SCORED_SERIES.filter(s => metrics[s.key]?.latest == null).map(s => s.label);

  return {
    asOf: new Date().toISOString(),
    anchorDate: anchorDate || new Date().toISOString().slice(0, 10),
    dataPath,
    vintagesAvailable: hasApiKey(),
    composite,
    confidence,
    signals,
    indicators,
    releases,
    thresholds: THRESHOLDS,
    caveats: [
      'A bias read from seven data series, not a forecast of any rate decision. The FOMC also weighs financial stability, credit conditions and global growth, none of which are inputs here.',
      'Core PCE publishes about 30 days after its reference month and core CPI about 13, so at any moment the two describe different months — compare the reference dates before reading a divergence.',
      'Payrolls are revised in each of the next two releases and again at the annual benchmark; the seasonally-adjusted CPI and unemployment series are revised each February.',
      'Values shown are the LATEST vintage — the current best estimate, recomputed when a revision arrives — not the figure first published. Prior vintages are kept, so an as-of read is available for anything that must not use hindsight.',
      'Every price index here is seasonally adjusted (CPIAUCSL, CPILFESL, PCEPILFE). The not-seasonally-adjusted twins run several points apart over a six-month window, because half a seasonal cycle is mostly seasonality.',
      ...(missing.length ? [`No current reading for: ${missing.join(', ')}. Those weights are excluded and the rest renormalised, so coverage is ${(composite.coverage * 100).toFixed(0)}%.`] : []),
      ...(staleSeries.length ? [`Stale: ${staleSeries.join(', ')}.`] : []),
      ...(Object.keys(fetchErrors).length ? [`Fetch failed for: ${Object.keys(fetchErrors).join(', ')}.`] : []),
      ...(dataPath === 'fred-live' ? ['Served live from FRED — macro_observations is empty or unreachable, so no stored vintages back these numbers.'] : []),
      ...(indicators.find(i => i.seriesId === 'DCOILWTICO')?.live
        ? [`Oil shows a live ${indicators.find(i => i.seriesId === 'DCOILWTICO').live.symbol} quote for reference, but the SCORE uses FRED's settled Cushing spot series — they are different instruments, and running a six-month window on front-month futures would bake contract-roll jumps into the rate of change.${indicators.find(i => i.seriesId === 'DCOILWTICO').live.wouldChangeScore ? ' The live price WOULD move the oil component if it were used.' : ' At the current price it would not change the oil component.'}`]
        : []),
      ...(hasApiKey() ? [] : ['FRED_API_KEY is not set, so vintage (as-known-at-the-time) data is unavailable and the regime cannot yet be reconstructed historically.']),
    ],
  };
}

/**
 * Write today's regime, before the outcome exists.
 *
 * This is the recorded evidence — the same standard as stock_pick_snapshots,
 * and the only kind that is not a reconstruction. Idempotent on snap_date, so
 * a retry after a transient failure is safe.
 */
async function recordSnapshot(monitor) {
  const row = {
    snap_date: monitor.anchorDate,
    composite_score: monitor.composite.score,
    regime: monitor.composite.regime,
    bias: monitor.composite.bias,
    confidence_level: monitor.confidence.level,
    confidence_score: monitor.confidence.score,
    coverage: monitor.composite.coverage,
    signals: monitor.signals,
    metrics: Object.fromEntries(monitor.indicators.map(i => [i.key, {
      latest: i.latest, latestDate: i.latestDate, ageDays: i.ageDays,
      rocPct: i.rocPct, changePp: i.changePp,
      annualized3m: i.annualized3m, annualized6m: i.annualized6m,
      yoyPct: i.yoyPct, avg3mChange: i.avg3mChange,
    }])),
    thresholds: monitor.thresholds,
  };
  const { error } = await supabase.from('macro_signal_snapshots').upsert(row, { onConflict: 'snap_date' });
  if (error) throw new Error(`macro_signal_snapshots: ${error.message}`);
  return row.snap_date;
}

module.exports = { buildMonitor, recordSnapshot, nextRelease, WINDOW_MONTHS };
