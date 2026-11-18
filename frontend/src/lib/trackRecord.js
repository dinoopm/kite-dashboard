// ─── One list of every claim the app makes, and where each stands ───────────
//
// The app has several scorecards, each answering for its own corner: Indian
// signals (/api/signals/scorecard), US quant picks, RRG rotation. Their
// results surface only as small badges beside each signal, so "which parts of
// this can I trust?" had no single answer. This merges them into one list and
// sorts each claim into one of four plain states.
//
// It adds no judgement of its own: the state is read off the `headline` each
// scorer already produced, so the page can never disagree with a badge.

/**
 * measured  a direction was called on enough resolved firings
 * no-edge   enough firings, and the result is indistinguishable from chance
 * thin      too few resolved firings to say anything yet (or none)
 * blocked   cannot be scored yet; the registry says why
 */
export function statusOf(headline) {
  const state = headline?.state
  if (state === 'unscoreable') return 'blocked'
  if (state === 'positive' || state === 'negative' || state === 'held' || state === 'refuted') return 'measured'
  if (state === 'thin' && /^no clear edge/i.test(headline.text || '')) return 'no-edge'
  return 'thin'
}

export const STATUS_ORDER = ['measured', 'no-edge', 'thin', 'blocked']
export const STATUS_META = {
  measured: { title: 'Measured, with a result', blurb: 'Enough resolved firings to name a direction. Green beat the benchmark, red lagged it; for warnings, "held" means the warning was right.' },
  'no-edge': { title: 'Measured, no clear edge', blurb: 'Tested on enough history, and the result is what chance would produce. Read these as descriptions of the past, not forecasts.' },
  thin: { title: 'Too few to judge', blurb: 'Being recorded, but not enough firings have resolved for a direction to mean anything. A hit rate on a handful of samples is noise.' },
  blocked: { title: 'Cannot be scored yet', blurb: 'Shown in the app but not measurable today. Each says what is missing. Treat as unvalidated.' },
}

const BENCHMARK_NAME = { '^NSEI': 'NIFTY 50', 'NSE:NIFTY 50': 'NIFTY 50' }
const benchName = (b, fallback) => BENCHMARK_NAME[b] || b || fallback

function row(entry, { market, benchmark, card }) {
  return {
    id: `${entry.signal}|${entry.source || ''}|${entry.ruleVersion || ''}`,
    signal: entry.signal,
    label: entry.label || entry.signal,
    description: entry.description || null,
    market: entry.market || market,
    source: entry.source || null,
    direction: entry.direction || 'bullish',
    ruleVersion: entry.ruleVersion || null,
    firings: entry.firings || 0,
    symbols: entry.symbols || 0,
    weeks: entry.weeks ?? null,
    since: entry.firstFired || null,
    until: entry.lastFired || null,
    horizons: entry.horizons || [],
    headline: entry.headline,
    status: statusOf(entry.headline),
    benchmark, card,
    olderVersions: 0,
    versions: [],
    // true when the scorecard tracks a current rule version for this signal
    // and this row is NOT it — the newest evidence there is, under older rules.
    supersededRules: false,
  }
}

/**
 * One row per (signal, evidence source). A signal's history is split by rule
 * version, and listing every version would bury the page in near-duplicates,
 * so: the row measured under the CURRENT rules if there is one, otherwise the
 * most recent version — flagged, because "the newest evidence is from rules
 * that have since changed" is something the reader must be told. The others
 * are counted on the row, never added into it.
 */
function onePerSignal(entries) {
  const groups = new Map()
  for (const e of entries) {
    const k = `${e.signal}|${e.source || ''}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(e)
  }
  const out = []
  for (const list of groups.values()) {
    const current = list.find(e => e.currentRules === true)
    const newest = [...list].sort((a, b) => String(b.lastFired || '').localeCompare(String(a.lastFired || '')))[0]
    const chosen = current || newest
    // Every version, newest first, for the expanded row: a version that has
    // only run for six weeks describes those six weeks, and the reader should
    // be able to see the five months measured under the version before it.
    const versions = [...list]
      .sort((a, b) => String(b.lastFired || '').localeCompare(String(a.lastFired || '')))
      .map(e => ({ ruleVersion: e.ruleVersion || null, current: e.currentRules === true, shown: e === chosen, since: e.firstFired || null, until: e.lastFired || null, firings: e.firings || 0, text: e.headline?.text || '', state: e.headline?.state || null }))
    out.push({ entry: chosen, versions, olderVersions: list.length - 1, supersededRules: !current && list.some(e => e.currentRules === false) })
  }
  return out
}

/**
 * @param {{india?:object, usPicks?:object, rrg?:object}} cards  the three
 *   scorecard payloads; any may be missing (failed or still loading).
 * @returns rows, one per (signal, evidence source) — see onePerSignal.
 *
 * Recorded and reconstructed evidence for the same signal stay as two rows —
 * pooling them is the one thing every scorer here refuses to do.
 */
export function mergeScorecards({ india, usPicks, rrg } = {}) {
  const rows = []
  if (india?.signals) {
    const benchmark = benchName(india.params?.benchmark, 'NIFTY 50')
    for (const { entry, versions, olderVersions, supersededRules } of onePerSignal(india.signals)) {
      rows.push({ ...row(entry, { market: 'IN', benchmark, card: 'india' }), versions, olderVersions, supersededRules })
    }
  }
  if (usPicks?.signals) {
    for (const e of usPicks.signals) rows.push(row(e, { market: 'US', benchmark: benchName(usPicks.params?.benchmark, 'SPY'), card: 'usPicks' }))
  }
  if (rrg?.signals) {
    for (const e of rrg.signals) rows.push(row(e, { market: rrg.market || 'US', benchmark: benchName(rrg.benchmark, 'SPY'), card: 'rrg' }))
  }
  // A blocked entry is listed by the Indian scorecard whatever its market, and
  // a scorer of its own may list the same signal: keep the scored one.
  const scored = new Set(rows.filter(r => r.status !== 'blocked').map(r => r.signal))
  return rows.filter(r => r.status !== 'blocked' || !scored.has(r.signal))
}

export function summarize(rows) {
  const counts = Object.fromEntries(STATUS_ORDER.map(s => [s, 0]))
  for (const r of rows) counts[r.status]++
  return { total: rows.length, counts }
}

const RANK = { recorded: 0, reconstructed: 1 }
/** Within a state: India before US, then by label, recorded before reconstructed. */
export function sortRows(rows) {
  return [...rows].sort((a, b) =>
    a.market.localeCompare(b.market) || a.label.localeCompare(b.label) || (RANK[a.source] ?? 2) - (RANK[b.source] ?? 2))
}

export const evidenceLabel = (source) => (source === 'recorded' ? 'Recorded' : source === 'reconstructed' ? 'Reconstructed' : '—')
