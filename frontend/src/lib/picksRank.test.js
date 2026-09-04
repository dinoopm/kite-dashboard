import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { percentileRanks, rankRows } from './picksRank.js'

// The Indian page's inline copy, verbatim, so the move is provably a no-op.
function indiaPercentileRanks(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  return values.map(v => {
    let lo = 0, hi = n
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid }
    const first = lo
    hi = n
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid + 1; else hi = mid }
    return n ? ((first + lo) / 2 / n) * 100 : 0
  })
}

describe('percentileRanks', () => {
  test('matches the Indian page on every non-null input', () => {
    const cases = [[0, 0, 0, 5], [3, 1, 2], [1, 1, 1], [], [-2, 0, 2, 2, 9]]
    for (const c of cases) assert.deepEqual(percentileRanks(c), indiaPercentileRanks(c))
  })
  test('nulls land at exactly 50 and do not shift the rest', () => {
    assert.deepEqual(percentileRanks([1, null, 3]), [25, 50, 75])
  })
})

describe('rankRows', () => {
  test('weights, sorts, and numbers from 1', () => {
    const stocks = [
      { symbol: 'A', factors: { m: 3, v: 0 } },
      { symbol: 'B', factors: { m: 1, v: 9 } },
    ]
    const rows = rankRows(stocks, [{ key: 'mom', raw: 'm' }, { key: 'vol', raw: 'v' }], { mom: 100, vol: 0 })
    assert.deepEqual(rows.map(r => r.symbol), ['A', 'B'])
    assert.deepEqual(rows.map(r => r.rank), [1, 2])
    assert.equal(rows[0].composite, 75)
  })
})
