import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateRiskScenario,
  exceedsLimit,
  getScenarioExposure,
  normalizeOptionalLimit,
} from './portfolioRisk.js'

const data = {
  summary: { coveredValue: 1000 },
  sectors: [{ sector: 'Energy', currentValue: 400 }],
  positions: [{ key: 'ISIN:1', currentValue: 250 }],
}

test('optional limits clamp to a percentage and equality is not exceeded', () => {
  assert.equal(normalizeOptionalLimit(''), null)
  assert.equal(normalizeOptionalLimit(120), 100)
  assert.equal(exceedsLimit(20, 20), false)
  assert.equal(exceedsLimit(20.01, 20), true)
});

test('selects scenario exposure from complete portfolio data', () => {
  assert.equal(getScenarioExposure(data, 'portfolio'), 1000)
  assert.equal(getScenarioExposure(data, 'sector:Energy'), 400)
  assert.equal(getScenarioExposure(data, 'holding:ISIN:1'), 250)
  assert.equal(getScenarioExposure({ ...data, filteredPositions: [] }, 'holding:ISIN:1'), 250)
});

test('calculates whole-portfolio scenarios at 0, 10, and 100 percent', () => {
  assert.equal(calculateRiskScenario({ coveredValue: 1000, affectedExposure: 1000, declinePct: 0 }).hypotheticalLoss, 0)
  assert.deepEqual(
    calculateRiskScenario({ coveredValue: 1000, affectedExposure: 1000, declinePct: 10 }),
    { affectedExposure: 1000, declinePct: 10, hypotheticalLoss: 100, portfolioLossPct: 10, resultingValue: 900 }
  )
  assert.equal(calculateRiskScenario({ coveredValue: 1000, affectedExposure: 1000, declinePct: 100 }).resultingValue, 0)
});

test('calculates sector and holding loss against total portfolio value', () => {
  const sector = calculateRiskScenario({ coveredValue: 1000, affectedExposure: 400, declinePct: 10 })
  const holding = calculateRiskScenario({ coveredValue: 1000, affectedExposure: 250, declinePct: 100 })
  assert.equal(sector.portfolioLossPct, 4)
  assert.equal(holding.hypotheticalLoss, 250)
  assert.equal(holding.resultingValue, 750)
});

