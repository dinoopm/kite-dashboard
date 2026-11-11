import { test } from 'node:test'
import assert from 'node:assert/strict'
import { growthBlock, epsNote, netMarginNote } from './pnlChecks.js'

// Honeywell as /api/us/pnl returns it after statementChecks has run.
const rows = [
  { label: 'FY 2022', eps: 14.54 },
  { label: 'FY 2023', eps: 16.94, basisBreak: { fields: ['revenue', 'operatingIncome'], restated: 'FY 2023', restatedFiled: '2026-02-17', unrestated: 'FY 2022' } },
  { label: 'FY 2024', eps: 17.42 },
  { label: 'FY 2025', eps: 15.98, epsCheck: { filed: 7.36, expected: 14.7246, factor: 2.0006 } },
]

test('growth across a restatement is blocked for the lines it changed', () => {
  const b = growthBlock(rows, 1, 'revenue')
  assert.equal(b.kind, 'basis')
  assert.match(b.title, /FY 2023 was restated in the filing of 2026-02-17/)
  assert.match(b.title, /FY 2022/)
  assert.equal(growthBlock(rows, 1, 'operatingIncome').kind, 'basis')
})

test('net income growth across the same restatement is still shown', () => {
  assert.equal(growthBlock(rows, 1, 'netIncome'), null)
})

test('EPS growth into and out of a disputed year is blocked', () => {
  assert.equal(growthBlock(rows, 3, 'eps').kind, 'eps')
  const next = [...rows, { label: 'FY 2026', eps: 18 }]
  assert.equal(growthBlock(next, 4, 'eps').kind, 'eps')
  assert.equal(growthBlock(rows, 2, 'eps'), null)
})

test('the first column has nothing to grow from', () => {
  assert.equal(growthBlock(rows, 0, 'revenue'), null)
})

test('the EPS note gives the filed figure and what it implies after the split', () => {
  const note = epsNote(rows[3])
  assert.match(note, /Yahoo shows \$15\.98/)
  assert.match(note, /filing reports \$7\.36/)
  assert.match(note, /\$14\.72/)
  assert.match(note, /×2\.00/)
  assert.equal(epsNote(rows[2]), null)
})

test('the net margin note names what was left out', () => {
  const note = netMarginNote({ label: 'FY 2023', netMarginBasis: 'continuing', discontinued: 743e6, continuingNetIncome: 4915e6 })
  assert.match(note, /continuing operations/)
  assert.match(note, /\$743\.00M/)
  assert.equal(netMarginNote({ label: 'FY 2022' }), null)
})
