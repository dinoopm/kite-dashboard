import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { percentileBelow, impliedDailyMovePct, etDate, sessionsAfter, freshnessRows } from './vixPage.js'

describe('percentileBelow', () => {
  // Replaces the "1Y change" card: for an index that reverts to its mean, where
  // today sits in the range says far more than where it sat a year ago.
  test('is the share of closes strictly below the value', () => {
    assert.equal(percentileBelow([10, 12, 14, 16, 18], 15), 60)
    assert.equal(percentileBelow([10, 12, 14, 16, 18], 9), 0)
    assert.equal(percentileBelow([10, 12, 14, 16, 18], 30), 100)
  })

  test('refuses to rank on too little history', () => {
    assert.equal(percentileBelow([14], 15), null)
    assert.equal(percentileBelow([10, 12], NaN), null)
  })
})

describe('impliedDailyMovePct', () => {
  // VIX is annualised; one trading day is 1/252 of a year, so the one-standard-
  // deviation daily S&P move it implies is VIX / sqrt(252). Arithmetic on the
  // index's own definition, not a forecast.
  test('converts the annualised index to a one-sigma daily move', () => {
    assert.equal(impliedDailyMovePct(21.01).toFixed(2), '1.32')
    assert.equal(impliedDailyMovePct(15.87).toFixed(2), '1.00')
  })

  test('is null for a missing level', () => {
    assert.equal(impliedDailyMovePct(null), null)
    assert.equal(impliedDailyMovePct(0), null)
  })
})

describe('etDate', () => {
  test('reads an instant as its New York calendar date', () => {
    assert.equal(etDate('2026-11-03T14:24:00Z'), '2026-11-03')
    assert.equal(etDate('2026-10-27T02:00:00Z'), '2026-10-26', '10pm ET is still the previous day')
  })

  test('passes a plain date through', () => {
    assert.equal(etDate('2026-10-30'), '2026-10-30')
  })
})

describe('sessionsAfter', () => {
  test('counts sessions after a date', () => {
    assert.equal(sessionsAfter(['2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03'], '2026-10-30'), 2)
  })
})

describe('freshnessRows', () => {
  // The 2026-11-03 page: four blocks, four different as-of dates, none of them
  // said how far behind it was.
  const vix = {
    asOf: '2026-11-03T14:24:00Z', kind: 'quote', historyAsOf: '2026-11-02',
    series: ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03'].map(date => ({ date })),
  }
  const severity = { asOf: '2026-10-30', context: { waitingOn: { date: '2026-11-02', missing: ['HY OAS'] } } }
  const cnn = { asOf: '2026-10-26T23:59:53.000Z', ageDays: 8, stale: true }

  test('gives each block its date and how many sessions it trails', () => {
    const rows = freshnessRows({ vix, severity, cnn })
    const by = Object.fromEntries(rows.map(r => [r.id, r]))
    assert.equal(by.quote.date, '2026-11-03')
    assert.equal(by.quote.behind, 0)
    assert.equal(by.history.behind, 1)
    assert.equal(by.severity.behind, 2)
    assert.equal(by.cnn.date, '2026-10-26')
    assert.equal(by.cnn.behind, 6)
  })

  // Lag that is built into a source is not staleness: today's close is not
  // final until evening, and HY OAS publishes a session late.
  test('flags only what is behind beyond its normal lag', () => {
    const by = Object.fromEntries(freshnessRows({ vix, severity, cnn }).map(r => [r.id, r]))
    assert.equal(by.quote.stale, false)
    assert.equal(by.history.stale, false)
    assert.equal(by.severity.stale, false)
    assert.equal(by.cnn.stale, true)
    assert.match(by.severity.note, /HY OAS/)
    assert.match(by.cnn.note, /8 days old/)
  })

  test('marks the severity assessment stale past its normal lag', () => {
    const rows = freshnessRows({ vix, severity: { ...severity, asOf: '2026-10-27' }, cnn })
    assert.equal(rows.find(r => r.id === 'severity').stale, true)
  })

  test('leaves out blocks that have not loaded', () => {
    assert.deepEqual(freshnessRows({ vix, severity: null, cnn: null }).map(r => r.id), ['quote', 'history'])
  })
})
