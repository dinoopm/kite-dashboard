import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { barInterval, relativeVolume, barOpacity } from './relativeVolume.js'
import { volumeStats, THRUST_MULT } from './volumeThrust.js'

const day = (i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)
// 30 quiet daily bars at 1M shares, then one heavy up day at 3M.
const daily = Array.from({ length: 31 }, (_, i) => ({
  date: day(i), open: 100 + i, close: 100 + i + (i === 30 ? 2 : 0.5), volume: i === 30 ? 3_000_000 : 1_000_000,
}))

describe('barInterval', () => {
  // Relative volume is only meaningful against bars of the same kind. On
  // 15-minute bars the open and the close are ALWAYS heavy, so a 20-bar
  // baseline would flag them every single day and teach the reader nothing.
  test('tells intraday, daily and weekly bars apart', () => {
    const intraday = Array.from({ length: 30 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 2, 14, 30) + i * 15 * 60e3).toISOString() }))
    const weekly = Array.from({ length: 30 }, (_, i) => ({ date: day(i * 7) }))
    assert.equal(barInterval(intraday), 'intraday')
    assert.equal(barInterval(daily), 'daily')
    assert.equal(barInterval(weekly), 'weekly')
  })

  test('reads a weekend gap as still daily', () => {
    const weekdays = []
    for (let i = 0; weekdays.length < 30; i++) {
      const d = new Date(Date.UTC(2026, 0, 5 + i))
      if (d.getUTCDay() % 6 !== 0) weekdays.push({ date: d.toISOString().slice(0, 10) })
    }
    assert.equal(barInterval(weekdays), 'daily')
  })

  test('is unknown with too few bars', () => {
    assert.equal(barInterval([{ date: day(0) }]), null)
  })
})

describe('relativeVolume', () => {
  // The bug this replaces: the pane divided EVERY bar by one average taken
  // over the last 20 bars of the whole series, so a May bar was measured
  // against November. Each bar now has its own trailing baseline.
  test('measures every bar against its own trailing average, not the latest one', () => {
    const r = relativeVolume(daily)
    assert.equal(r.ratio[25], 1)
    assert.equal(r.ratio[30], 3)
    assert.deepEqual(r.ratio, volumeStats(daily).ratio, 'identical arithmetic to the registered detector')
  })

  test('summarises the latest bar', () => {
    const r = relativeVolume(daily)
    assert.equal(r.latest.ratio, 3)
    assert.equal(r.latest.heavy, true)
    assert.equal(r.latest.pctBusier, 100, 'busier than every other measured bar in view')
    assert.equal(r.measured, 11, 'only bars with a full 20-bar baseline are ranked')
  })

  test('flags heavy bars at the registered multiple, in either direction', () => {
    const r = relativeVolume(daily)
    assert.equal(THRUST_MULT, 2)
    assert.equal(r.heavy[30], true)
    assert.equal(r.heavy[25], false)
    assert.equal(r.thrust[30], true, 'and marks the registered firing on an up close')
  })

  test('says nothing without enough history', () => {
    const r = relativeVolume(daily.slice(0, 15))
    assert.equal(r.latest, null)
  })
})

describe('barOpacity', () => {
  // Continuous, not banded: brightness follows the ratio, so no new threshold
  // is invented. The only line drawn is the registered 2x.
  test('dims below-average bars and saturates at the registered multiple', () => {
    assert.equal(barOpacity(null), 0.45)
    assert.equal(barOpacity(0.5), 0.25)
    assert.equal(barOpacity(1), 0.4)
    assert.equal(barOpacity(2), 1)
    assert.equal(barOpacity(5), 1)
    assert.ok(barOpacity(1.5) > barOpacity(1) && barOpacity(1.5) < barOpacity(2))
  })
})

import { sessionInProgress } from './relativeVolume.js'

describe('sessionInProgress', () => {
  // During market hours the last daily bar is still counting: a stock at 0.6x
  // its average at 11am can close at 2x. Calling that partial bar "light" — or
  // a thrust — states a reading the session has not finished producing.
  test('is true for today\'s US bar before the 16:00 ET close', () => {
    assert.equal(sessionInProgress('2026-11-04T05:00:00Z', new Date('2026-11-04T18:00:00Z'), 'US'), true)
  })

  test('is false once the US session has closed', () => {
    assert.equal(sessionInProgress('2026-11-04T05:00:00Z', new Date('2026-11-04T21:35:00Z'), 'US'), false)
  })

  test('is false for a bar from an earlier day', () => {
    assert.equal(sessionInProgress('2026-11-03T05:00:00Z', new Date('2026-11-04T18:00:00Z'), 'US'), false)
  })

  test('uses the Indian session for an Indian bar', () => {
    assert.equal(sessionInProgress('2026-11-04T00:00:00+05:30', new Date('2026-11-04T06:00:00Z'), 'IN'), true, '11:30 IST')
    assert.equal(sessionInProgress('2026-11-04T00:00:00+05:30', new Date('2026-11-04T10:30:00Z'), 'IN'), false, '16:00 IST, after the 15:30 close')
  })
})
