// ─── Ranking maths shared by the Indian and US quant-picks pages ─────────────
// Mid-rank percentile (0–100) of each value within the array. Ties share the
// MIDDLE of their block — most stocks sit at 0 on any given factor (e.g. no
// large deals), and max-rank ties would reward having no data at all.
//
// `null` means "no data" and lands at exactly 50 — a missing EPS revision is
// not a bad revision. The Indian page pre-fills `?? 0` before calling this, so
// its output is unchanged by the move (see picksRank.test.js).
export function percentileRanks(values) {
  const known = values.filter(v => v != null)
  const sorted = [...known].sort((a, b) => a - b)
  const n = sorted.length
  return values.map(v => {
    if (v == null) return 50
    let lo = 0, hi = n
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid }
    const first = lo // count of values < v
    hi = n
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid + 1; else hi = mid }
    return n ? ((first + lo) / 2 / n) * 100 : 0 // lo = count of values <= v
  })
}

/** Percentile each factor, blend by normalised weights, sort, number from 1. */
export function rankRows(stocks, factors, weights) {
  const cols = {}
  for (const f of factors) cols[f.key] = percentileRanks(stocks.map(s => s.factors[f.raw]))
  const sumW = factors.reduce((a, f) => a + (weights[f.key] || 0), 0) || 1
  const rows = stocks.map((s, i) => {
    const pct = {}; let composite = 0
    for (const f of factors) { pct[f.key] = cols[f.key][i]; composite += ((weights[f.key] || 0) / sumW) * pct[f.key] }
    return { ...s, pct, composite }
  })
  rows.sort((a, b) => b.composite - a.composite)
  return rows.map((r, i) => ({ ...r, rank: i + 1 }))
}
