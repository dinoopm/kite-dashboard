import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { sinceText, changesIn, cellTitle } from './regimeHistory.js'

describe('sinceText', () => {
  test('names the start and what came before', () => {
    const since = { label: 'NEUTRAL', since: '2026-11-13', sessions: 1, atLeast: false,
      previous: { label: 'RISK-OFF', from: '2026-10-22', to: '2026-11-12', sessions: 16 } }
    assert.equal(sinceText(since, 60), 'NEUTRAL since 13 Nov — RISK-OFF before that, 22 Oct – 12 Nov (16 sessions).')
  })

  test('a one-session previous run names one day', () => {
    const since = { label: 'RISK-OFF', since: '2026-10-22', sessions: 3, atLeast: false,
      previous: { label: 'NEUTRAL', from: '2026-10-21', to: '2026-10-21', sessions: 1 } }
    assert.match(sinceText(since, 60), /NEUTRAL before that, 21 Oct \(1 session\)/)
  })

  test('a word that changed today says so', () => {
    const since = { label: 'RISK-ON', since: null, sessions: 0, atLeast: false,
      previous: { label: 'NEUTRAL', from: '2026-11-13', to: '2026-11-20', sessions: 6 } }
    assert.match(sinceText(since, 60), /^RISK-ON as of today's live read — NEUTRAL before that/)
  })

  test('a run filling the strip does not invent a start date', () => {
    assert.equal(sinceText({ label: 'NEUTRAL', since: '2026-08-21', sessions: 60, atLeast: true, previous: null }, 60),
      'NEUTRAL for all of the last 60 sessions.')
  })

  test('nothing to say without data', () => {
    assert.equal(sinceText(null, 0), null)
  })
})

test('changesIn counts flips, not sessions', () => {
  const h = ['NEUTRAL', 'RISK-ON', 'NEUTRAL', 'NEUTRAL', 'RISK-OFF'].map(label => ({ label }))
  assert.equal(changesIn(h), 3)
  assert.equal(changesIn([]), 0)
  assert.equal(changesIn(null), 0)
})

test('cellTitle carries the three readings behind the word', () => {
  const t = cellTitle({ date: '2026-11-12', label: 'RISK-OFF', yield: 5.1, yield1mo: -0.09, spyTlt1mo: -2.7, hygLqd1mo: -0.2 })
  assert.match(t, /^12 Nov · RISK-OFF/)
  assert.match(t, /10Y 5\.10% \(-0\.09pp in a month\)/)
  assert.match(t, /S&P vs Treasuries -2\.7pp · junk vs IG -0\.2pp/)
})
