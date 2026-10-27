import { normalizeOptionalLimit } from './portfolioRisk.js'

// Allocation is measured against covered EQUITY value. Holding proceeds as
// cash therefore reduces both the position and its equity denominator.
export function calculatePositionTrim({ currentValue, coveredValue, quantity, limit, proceeds = 'cash' }) {
  const target = normalizeOptionalLimit(limit)
  if (target == null || !Number.isFinite(currentValue) || !Number.isFinite(coveredValue) || !Number.isFinite(quantity)
    || coveredValue <= 0 || currentValue <= 0 || currentValue > coveredValue || quantity <= 0 || target >= 100) return null
  const fraction = target / 100
  if (currentValue / coveredValue <= fraction) return null
  const price = currentValue / quantity
  const requiredValue = (currentValue - fraction * coveredValue) / (proceeds === 'cash' ? 1 - fraction : 1)
  const quantityToSell = Math.min(quantity, Math.ceil(requiredValue / price - 1e-10))
  const estimatedProceeds = quantityToSell * price
  const remainingPositionValue = Math.max(0, currentValue - estimatedProceeds)
  const remainingEquityValue = Math.max(0, coveredValue - (proceeds === 'cash' ? estimatedProceeds : 0))
  return { quantityToSell, estimatedProceeds, referencePrice: price, remainingPositionValue, remainingEquityValue,
    remainingWeightPct: remainingEquityValue > 0 ? remainingPositionValue / remainingEquityValue * 100 : 0,
    targetPct: target, proceeds: proceeds === 'cash' ? 'cash' : 'reinvest' }
}
