export function normalizeOptionalLimit(value) {
  if (value === '' || value === null || value === undefined) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.min(100, Math.max(0, parsed))
}

export function exceedsLimit(weightPct, limit) {
  const normalized = normalizeOptionalLimit(limit)
  return normalized !== null && Number(weightPct) > normalized
}

export function getScenarioExposure(data, target) {
  if (!data || !target) return 0
  if (target === 'portfolio') return Number(data.summary?.coveredValue) || 0
  if (target.startsWith('sector:')) {
    const sector = target.slice('sector:'.length)
    return Number(data.sectors?.find(item => item.sector === sector)?.currentValue) || 0
  }
  if (target.startsWith('holding:')) {
    const key = target.slice('holding:'.length)
    return Number(data.positions?.find(item => item.key === key)?.currentValue) || 0
  }
  return 0
}

export function calculateRiskScenario({ coveredValue, affectedExposure, declinePct }) {
  const portfolioValue = Math.max(0, Number(coveredValue) || 0)
  const exposure = Math.min(portfolioValue, Math.max(0, Number(affectedExposure) || 0))
  const decline = Math.min(100, Math.max(0, Number(declinePct) || 0))
  const hypotheticalLoss = exposure * (decline / 100)
  return {
    affectedExposure: exposure,
    declinePct: decline,
    hypotheticalLoss,
    portfolioLossPct: portfolioValue > 0 ? (hypotheticalLoss / portfolioValue) * 100 : 0,
    resultingValue: Math.max(0, portfolioValue - hypotheticalLoss),
  }
}

