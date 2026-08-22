// ─── Suspected duplicate issuers ─────────────────────────────────────────────
//
// GOOG and GOOGL are both in the S&P 500 and carry the same company's
// financials, so a naive Σ net profit counts Alphabet twice. The aggregation
// fixes that by MERGING — financials once, caps summed — but it needs to be
// told which symbols are the same issuer, and a hand-curated pair list goes
// stale the moment a new dual-class listing arrives.
//
// So this detects them from the data itself. It lives here, in the ingest and
// data-health path, rather than inside aggregate.js: that module's value is
// being pure arithmetic with no I/O and no heuristics, and a fuzzy
// same-company guess is neither. Its findings reach the aggregation the way
// every other input does — as the issuer pair list.
//
// It FLAGS rather than auto-merges, deliberately. A wrong merge silently halves
// a sector; a wrong flag costs someone thirty seconds of confirmation.

// Exact equality is too brittle to be useful: a restatement lands on one class
// before the other, and a one-day skew between two fetches is enough to break
// it. Since the output is a suggestion, a loose net errs the safe way.
const MATCH_TOLERANCE = 0.001; // 0.1%

const close = (a, b) => {
  if (a == null || b == null) return false;
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale > 0 && Math.abs(a - b) / scale <= MATCH_TOLERANCE;
};

/**
 * Symbols whose revenue AND net profit agree for the same period.
 *
 * Both must match: revenue alone pairs up companies that merely happen to be
 * the same size, which in an index of 500 is not rare.
 *
 * @param rows stored fundamentals rows for one market
 * @returns [{ symbols: ['GOOG','GOOGL'], periods: 8, sample: '2026-06-30' }]
 */
function findSuspectedDuplicates(rows = []) {
  const byPeriod = new Map();
  for (const r of rows) {
    if (r.period_type !== 'quarter') continue;
    if (r.net_profit == null || r.revenue == null) continue;
    const key = `${r.market}|${r.period_end}`;
    if (!byPeriod.has(key)) byPeriod.set(key, []);
    byPeriod.get(key).push(r);
  }

  const pairHits = new Map(); // 'A|B' -> { count, sample }
  for (const [, list] of byPeriod) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.symbol === b.symbol) continue;
        if (!close(a.net_profit, b.net_profit)) continue;
        if (!close(a.revenue, b.revenue)) continue;
        const key = [a.symbol, b.symbol].sort().join('|');
        const hit = pairHits.get(key) || { count: 0, sample: a.period_end };
        hit.count++;
        pairHits.set(key, hit);
      }
    }
  }

  // One matching quarter is a coincidence; several is a share class. Two
  // genuinely different companies posting identical revenue AND profit for
  // multiple quarters running does not happen.
  return [...pairHits.entries()]
    .filter(([, h]) => h.count >= 2)
    .map(([key, h]) => ({ symbols: key.split('|'), periods: h.count, sample: h.sample }))
    .sort((a, b) => b.periods - a.periods);
}

/** Known dual-class issuers, kept as the trusted list the detector supplements. */
const CURATED_ISSUER_GROUPS = [
  ['GOOGL', 'GOOG'],
  ['FOXA', 'FOX'],
  ['NWSA', 'NWS'],
  ['UHAL', 'UHAL.B'],
  ['LEN', 'LEN.B'],
  ['BRK.A', 'BRK.B'],
];

/**
 * The pair list the aggregation should be handed: curated groups, plus detected
 * ones that are not already covered.
 */
function issuerGroups(rows = []) {
  const groups = CURATED_ISSUER_GROUPS.map(g => [...g]);
  const known = new Set(groups.flat());
  for (const d of findSuspectedDuplicates(rows)) {
    if (d.symbols.some(s => known.has(s))) continue;
    groups.push(d.symbols);
    d.symbols.forEach(s => known.add(s));
  }
  return groups;
}

module.exports = { findSuspectedDuplicates, issuerGroups, CURATED_ISSUER_GROUPS, MATCH_TOLERANCE };
