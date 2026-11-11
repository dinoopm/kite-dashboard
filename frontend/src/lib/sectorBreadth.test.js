import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeSectorBreadth } from './sectorBreadth.js'

const row = (name, symbol, token, aboveSma50, aboveSma200, aboveSma20 = aboveSma50) =>
  ({ name, symbol, token, aboveSma20, aboveSma50, aboveSma200, rsi14: 50, breakout: 0, '1D': 1 })

// The SMA lists name each stock; the panel needs symbol and token to link it.
test('SMA lists carry each stock\'s symbol and token', () => {
  const b = computeSectorBreadth([
    row('IonQ, Inc.', 'IONQ', 'IONQ', true, false),
    row('Microsoft Corporation', 'MSFT', 'MSFT', false, true),
  ])
  assert.deepEqual(b.sma.above50stocks, [{ name: 'IonQ, Inc.', symbol: 'IONQ', token: 'IONQ' }])
  assert.deepEqual(b.sma.below50stocks, [{ name: 'Microsoft Corporation', symbol: 'MSFT', token: 'MSFT' }])
  assert.deepEqual(b.sma.above200stocks, [{ name: 'Microsoft Corporation', symbol: 'MSFT', token: 'MSFT' }])
  assert.deepEqual(b.sma.below200stocks, [{ name: 'IonQ, Inc.', symbol: 'IONQ', token: 'IONQ' }])
})

// The short-term card reads the 50-day average, not the 20-day one.
test('a stock above its 20-day but below its 50-day counts as below', () => {
  const b = computeSectorBreadth([
    row('Up short-term only', 'A', 'A', false, true, true),
    row('Above both', 'B', 'B', true, true, true),
  ])
  assert.deepEqual(b.sma.below50stocks.map(s => s.symbol), ['A'])
  assert.equal(b.sma.pct50, 50)
})

test('a stock with unknown SMA-200 is in neither SMA-200 list', () => {
  const b = computeSectorBreadth([row('New listing', 'NEW', 'NEW', true, null)])
  assert.deepEqual(b.sma.above200stocks, [])
  assert.deepEqual(b.sma.below200stocks, [])
})

// A listing with 20–49 sessions still counts for today's advance/decline, but
// it has no 50-day average, so it stays out of both SMA-50 lists and the
// percentage is taken over the stocks that have one.
test('a stock with too little history for SMA-50 is left out of that percentage only', () => {
  const b = computeSectorBreadth([
    row('Recent listing', 'NEW', 'NEW', null, null, true),
    row('Established', 'OLD', 'OLD', true, true, true),
  ])
  assert.equal(b.loadedCount, 2)
  assert.equal(b.advDecline.total, 2)
  assert.deepEqual(b.sma.above50stocks.map(s => s.symbol), ['OLD'])
  assert.deepEqual(b.sma.below50stocks, [])
  assert.equal(b.sma.pct50, 100)
  assert.equal(b.sma.count50, 1)
})
