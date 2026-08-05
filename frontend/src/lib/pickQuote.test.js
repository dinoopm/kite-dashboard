import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { quoteCandidates, pickQuote, dayChangeFrom } from './pickQuote.js'

// Real figures from Kite, 2026-08-04. Same stock, same moment, two venues:
// the last prices agree to 5 paise but the previous closes differ by 2.8%,
// which is the entire bug.
const CGPOWER = {
  'NSE:CGPOWER': { instrument_token: 194561, last_price: 880.05, ohlc: { close: 826.1 } },
  'BSE:CGPOWER': { instrument_token: 128023812, last_price: 880, ohlc: { close: 850 } },
}

describe('quoteCandidates', () => {
  test('asks both venues so a wrong hint can be overridden', () => {
    const c = quoteCandidates('CGPOWER', 'BSE')
    assert.ok(c.includes('NSE:CGPOWER'))
    assert.ok(c.includes('BSE:CGPOWER'))
  })

  test('puts the hinted exchange first', () => {
    assert.equal(quoteCandidates('CGPOWER', 'BSE')[0], 'BSE:CGPOWER')
    assert.equal(quoteCandidates('CGPOWER', 'NSE')[0], 'NSE:CGPOWER')
  })

  test('does not ask for the same key twice', () => {
    const c = quoteCandidates('CGPOWER', 'NSE')
    assert.equal(c.length, new Set(c).size)
    assert.equal(c.length, 2)
  })

  test('defaults to NSE and tolerates a missing symbol', () => {
    assert.equal(quoteCandidates('INFY')[0], 'NSE:INFY')
    assert.deepEqual(quoteCandidates(null), [])
  })
})

describe('pickQuote', () => {
  // The defect: arriving from the basket or portfolio with a BSE token still
  // showed NSE's book, reporting +6.53% against the broker's +3.53%.
  test('follows the BSE token to the BSE book', () => {
    const q = pickQuote(CGPOWER, { token: 128023812, quoteKey: 'NSE:CGPOWER' })
    assert.equal(q.ohlc.close, 850)
    assert.equal(dayChangeFrom(q).changePct, 3.53)
  })

  test('follows the NSE token to the NSE book', () => {
    const q = pickQuote(CGPOWER, { token: 194561, quoteKey: 'BSE:CGPOWER' })
    assert.equal(q.ohlc.close, 826.1)
    assert.equal(dayChangeFrom(q).changePct, 6.53)
  })

  // The token beats the hint precisely because most callers cannot supply one.
  test('the token overrides a contradicting exchange hint', () => {
    const q = pickQuote(CGPOWER, { token: 128023812, quoteKey: 'NSE:CGPOWER' })
    assert.equal(q.instrument_token, 128023812)
  })

  test('matches a token given as a string', () => {
    assert.equal(pickQuote(CGPOWER, { token: '128023812' }).ohlc.close, 850)
  })

  // 0 is the app's placeholder for "instrument not resolved", used by links
  // from the journal and peer lists. Treating it as a real token would match
  // nothing and skip straight past the caller's perfectly good hint.
  test('ignores the placeholder token and honours the hint', () => {
    const q = pickQuote(CGPOWER, { token: '0', quoteKey: 'BSE:CGPOWER' })
    assert.equal(q.ohlc.close, 850)
  })

  test('falls back to the hint when the token matches nothing', () => {
    const q = pickQuote(CGPOWER, { token: 999999, quoteKey: 'BSE:CGPOWER' })
    assert.equal(q.ohlc.close, 850)
  })

  // SIGMAADV's instrument is SIGMAADV-BE, so NSE:SIGMAADV returns nothing and
  // the quote card used to render blank. Showing the one venue that answered
  // beats showing nothing.
  test('shows whatever came back when neither token nor hint matches', () => {
    const only = { 'BSE:SIGMAADV': { instrument_token: 555, last_price: 687.4, ohlc: { close: 654.7 } } }
    const q = pickQuote(only, { token: 194561, quoteKey: 'NSE:SIGMAADV' })
    assert.equal(q.instrument_token, 555)
  })

  test('returns null rather than a broken object when there is nothing', () => {
    assert.equal(pickQuote({}, { token: 1 }), null)
    assert.equal(pickQuote(null, { token: 1 }), null)
    assert.equal(pickQuote(undefined, {}), null)
  })

  test('survives being called with no options at all', () => {
    assert.equal(pickQuote(CGPOWER).instrument_token, 194561, 'first entry')
  })
})

describe('dayChangeFrom', () => {
  test('computes the change against the previous close', () => {
    const d = dayChangeFrom(CGPOWER['BSE:CGPOWER'])
    assert.equal(d.change, 30)
    assert.equal(d.changePct, 3.53)
  })

  test('refuses to divide by a zero or missing previous close', () => {
    assert.equal(dayChangeFrom({ last_price: 100, ohlc: { close: 0 } }), null)
    assert.equal(dayChangeFrom({ last_price: 100 }), null)
    assert.equal(dayChangeFrom(null), null)
  })
})
