import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { tierProximity } from './tierProximity.js'

// The 2026-11-02 assessment: MIXED, so no card matched and none was
// highlighted — the panel looked as if the selection had gone missing. The
// reading sat between tiers, closest to STRESS with two of its three checks met.
const tiers = [
  { id: 'NEUTRAL', checks: [{ label: 'VIX < 15', pass: false }, { label: 'SPY return > TLT return over 21 sessions', pass: false }] },
  { id: 'CAUTION', checks: [{ label: '15 ≤ VIX < 20', pass: false }, { label: 'TLT return > SPY return over 21 sessions', pass: true }] },
  { id: 'STRESS', checks: [{ label: '20 ≤ VIX ≤ 30', pass: true }, { label: 'SPY ≥ 10% below its 252-session closing high', pass: false }, { label: 'HY OAS wider by > 0 bps over 21 sessions', pass: true }] },
  { id: 'CRASH MODE', checks: [{ label: 'VIX > 30', pass: false }, { label: 'SPY decline > 10% from a closing peak within 4 sessions', pass: false }, { label: 'HY OAS wider by ≥ 100 bps in 4 sessions', pass: false }] },
]

describe('tierProximity', () => {
  test('counts the checks each tier has met', () => {
    const p = tierProximity(tiers, 'MIXED')
    assert.deepEqual(p.map(t => [t.id, t.met, t.total]), [['NEUTRAL', 0, 2], ['CAUTION', 1, 2], ['STRESS', 2, 3], ['CRASH MODE', 0, 3]])
  })

  test('marks the closest tier when the reading is MIXED, and names what it lacks', () => {
    const p = tierProximity(tiers, 'MIXED')
    const nearest = p.filter(t => t.nearest)
    assert.deepEqual(nearest.map(t => t.id), ['STRESS'])
    assert.deepEqual(nearest[0].missing, ['SPY ≥ 10% below its 252-session closing high'])
  })

  // When a tier IS the verdict, it is selected outright; a "closest" marker
  // beside it would compete with the actual answer.
  test('marks nothing as nearest when a tier is the verdict', () => {
    assert.equal(tierProximity(tiers, 'CAUTION').some(t => t.nearest), false)
  })

  // Missing inputs are not evidence of distance.
  test('marks nothing when the assessment is incomplete', () => {
    assert.equal(tierProximity(tiers, 'INCOMPLETE').some(t => t.nearest), false)
  })

  test('marks every tier that ties for closest', () => {
    const tied = [
      { id: 'A', checks: [{ label: 'a1', pass: true }, { label: 'a2', pass: false }] },
      { id: 'B', checks: [{ label: 'b1', pass: false }, { label: 'b2', pass: true }] },
    ]
    assert.deepEqual(tierProximity(tied, 'MIXED').filter(t => t.nearest).map(t => t.id), ['A', 'B'])
  })

  test('marks nothing when no tier has a single check met', () => {
    const none = tiers.map(t => ({ ...t, checks: t.checks.map(c => ({ ...c, pass: false })) }))
    assert.equal(tierProximity(none, 'MIXED').some(t => t.nearest), false)
  })

  test('does not count an unavailable check as met', () => {
    const p = tierProximity([{ id: 'X', checks: [{ label: 'x', pass: null }, { label: 'y', pass: true }] }], 'MIXED')
    assert.equal(p[0].met, 1)
    assert.equal(p[0].total, 2)
  })
})
