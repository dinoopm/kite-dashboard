import { exceedsLimit } from './portfolioRisk.js'

const NUMERIC = new Set(['averageMarketCapCr', 'quantity', 'currentValue', 'weightPct', 'status'])
const CAP_ORDER = { 'Large Cap': 0, 'Mid Cap': 1, 'Small Cap': 2 }
export function sortRiskPositions(positions, key = 'weightPct', direction = 'desc', stockLimit = null) {
  const multiplier = direction === 'asc' ? 1 : -1
  const value = position => key === 'status' ? Number(exceedsLimit(position.weightPct, stockLimit)) : key === 'marketCapCategory' ? CAP_ORDER[position.marketCapCategory] ?? null : position[key]
  return [...positions].sort((a, b) => {
    const left = value(a), right = value(b)
    const numeric = NUMERIC.has(key) || key === 'marketCapCategory'
    const missing = item => item == null || item === '' || (numeric && !Number.isFinite(item))
    if (missing(left) !== missing(right)) return missing(left) ? 1 : -1
    const comparison = missing(left) ? 0 : numeric ? left - right : String(left).localeCompare(String(right), 'en', { sensitivity: 'base', numeric: true })
    return comparison * multiplier || String(a.symbol).localeCompare(String(b.symbol), 'en', { sensitivity: 'base', numeric: true }) || String(a.key).localeCompare(String(b.key))
  })
}
