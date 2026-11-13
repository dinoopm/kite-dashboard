import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { intradayBase, extendedQuoteLine, extendedColumn, extendedFor } from './usSession.js'

const quote = { last: 217.2, prevClose: 241, barDate: '2026-11-05' }
const bar = (date) => ({ date })

describe('intradayBase', () => {
  // The reported case: CRWD closed 217.20 on 5 Nov and traded 226.60 before the
  // open on 6 Nov. Measuring that from the 241.00 close of 4 Nov showed -5.98%
  // on a stock that was up 4.33%: two days' moves counted as one.
  test('measures a session with no daily bar yet from the last regular close', () => {
    assert.equal(intradayBase([bar('2026-11-06T09:30:00Z')], quote), 217.2)
  })

  test('measures a session that has its daily bar from the previous close', () => {
    assert.equal(intradayBase([bar('2026-11-05T20:45:00Z')], quote), 241)
  })

  // 7:45 PM ET is past UTC midnight, but it is still the same session.
  test('keeps post-market prints on their own session', () => {
    assert.equal(intradayBase([bar('2026-11-06T00:45:00Z')], quote), 241)
  })

  test('uses the newest bar when the view spans several', () => {
    assert.equal(intradayBase([bar('2026-11-05T20:45:00Z'), bar('2026-11-06T09:30:00Z')], quote), 217.2)
  })

  test('falls back to the previous close when the daily bar date is unknown', () => {
    assert.equal(intradayBase([bar('2026-11-06T09:30:00Z')], { last: 217.2, prevClose: 241 }), 241)
  })

  test('returns null with nothing to measure from', () => {
    assert.equal(intradayBase([], quote), null)
    assert.equal(intradayBase([bar('2026-11-05T20:45:00Z')], { barDate: '2026-11-05' }), null)
  })
})

describe('extendedQuoteLine', () => {
  const pre = { session: 'pre-market', asOf: '2026-11-06T09:34:09Z', feed: 'delayed_sip' }

  test('names the session and the time in ET', () => {
    const line = extendedQuoteLine(pre, new Date('2026-11-06T09:49:00Z'))
    assert.equal(line.label, 'Pre-market')
    assert.equal(line.when, '4:34 AM ET')
  })

  // A delayed price beside a live-looking one reads as a wrong one, so the line
  // says which feed it came from.
  test('says where the price came from', () => {
    const at = new Date('2026-11-06T09:49:00Z')
    assert.equal(extendedQuoteLine(pre, at).note, '15-min delayed')
    assert.equal(extendedQuoteLine({ ...pre, feed: 'yahoo' }, at).note, 'Yahoo')
    assert.equal(extendedQuoteLine({ ...pre, feed: 'sip' }, at).note, null)
  })

  // Friday's last print is still the newest one on Sunday.
  test('names the day when the print is not from today', () => {
    const line = extendedQuoteLine({ session: 'after-hours', asOf: '2026-11-07T00:59:00Z', feed: 'delayed_sip' }, new Date('2026-11-08T15:00:00Z'))
    assert.equal(line.label, 'After hours')
    assert.equal(line.when, 'Fri 7:59 PM ET')
  })

  test('is null when there is no out-of-hours print', () => {
    assert.equal(extendedQuoteLine(null), null)
  })
})

describe('extendedColumn', () => {
  const pre = { ext: { session: 'pre-market' } }
  const post = { ext: { session: 'after-hours' } }
  const none = { ext: null }

  // No column at all during the regular session, or a table of dashes.
  test('is null when no row has an out-of-hours price', () => {
    assert.equal(extendedColumn([none, none]), null)
    assert.equal(extendedColumn([]), null)
    assert.equal(extendedColumn(null), null)
  })

  test('names the session the rows are in', () => {
    assert.deepEqual(extendedColumn([pre, none]), { session: 'pre-market', label: 'Pre-market' })
    assert.deepEqual(extendedColumn([post]), { session: 'after-hours', label: 'After hours' })
  })

  // Before the open, a thin name's newest print can still be last night's.
  test('calls it pre-market as soon as any row is', () => {
    assert.equal(extendedColumn([post, pre]).session, 'pre-market')
  })
})

describe('extendedFor', () => {
  const pre = { ext: { session: 'pre-market', changePct: 1.2 } }
  const post = { ext: { session: 'after-hours', changePct: -3.4 } }
  const column = { session: 'pre-market', label: 'Pre-market' }

  test('gives the row its print when it is from the column\'s session', () => {
    assert.equal(extendedFor(pre, column), pre.ext)
  })

  // Shown as a dash, so it must sort as one too.
  test('is null for a print from the other session', () => {
    assert.equal(extendedFor(post, column), null)
  })

  test('is null with no column or no print', () => {
    assert.equal(extendedFor(pre, null), null)
    assert.equal(extendedFor({ ext: null }, column), null)
    assert.equal(extendedFor(undefined, column), null)
  })
})
