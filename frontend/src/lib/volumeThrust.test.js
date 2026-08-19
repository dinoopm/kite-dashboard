import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { volumeStats, confirmedAt, THRUST_MULT, MIN_BARS } from './volumeThrust.js'

// 40 quiet bars: 1000 lots a day, close up a rupee a day.
const quiet = (n = 40) => Array.from({ length: n }, (_, i) => ({ close: 100 + i, volume: 1000 }))

describe('volumeStats', () => {
  test('the baseline excludes the bar it measures', () => {
    const bars = quiet()
    bars[30].volume = 5000
    const { avg, ratio } = volumeStats(bars)
    // Were the spike inside its own 20-bar window the average would be 1200
    // and the ratio 4.17 — the exact dilution the backend detector avoids.
    assert.equal(avg[30], 1000)
    assert.equal(ratio[30], 5)
  })

  test('leaves the warm-up window unscored rather than guessing', () => {
    const { avg, ratio, thrust } = volumeStats(quiet())
    assert.equal(avg[19], null)
    assert.equal(ratio[19], null)
    assert.equal(thrust.slice(0, MIN_BARS).some(Boolean), false)
  })

  test('marks a heavy up day as a firing', () => {
    const bars = quiet()
    bars[30].volume = 1000 * THRUST_MULT
    const { elevated, thrust } = volumeStats(bars)
    assert.equal(elevated[30], true)
    assert.equal(thrust[30], true)
  })

  test('heavy volume on a down close is not a demand thrust', () => {
    const bars = quiet()
    bars[30].volume = 6000
    bars[30].close = bars[29].close - 4
    const { elevated, thrust } = volumeStats(bars)
    assert.equal(elevated[30], false)
    assert.equal(thrust[30], false)
  })

  // The distinction the chart draws in two shades: a run stays elevated but
  // fires once, so the scorecard's n counts calls rather than days.
  test('a run of heavy up days stays elevated but fires once', () => {
    const bars = quiet()
    bars[30].volume = 3000
    bars[31].volume = 4000
    bars[32].volume = 3500
    const { elevated, thrust } = volumeStats(bars)
    assert.deepEqual(elevated.slice(30, 33), [true, true, true])
    assert.deepEqual(thrust.slice(30, 33), [true, false, false])
  })

  test('a zero baseline yields no ratio instead of Infinity', () => {
    const bars = quiet().map(b => ({ ...b, volume: 0 }))
    bars[30].volume = 5000
    const { ratio, thrust } = volumeStats(bars)
    assert.equal(ratio[30], null)
    assert.equal(thrust[30], false)
  })
})

describe('confirmedAt', () => {
  const withHeavyAt = (idx) => {
    const bars = quiet(60)
    bars[idx].volume = 4000
    return volumeStats(bars)
  }

  test('finds a heavy up day inside the window', () => {
    assert.equal(confirmedAt(withHeavyAt(38), 40, 5), 38)
  })

  test('ignores one outside it', () => {
    assert.equal(confirmedAt(withHeavyAt(30), 40, 5), -1)
  })

  test('is inclusive of the bar itself', () => {
    assert.equal(confirmedAt(withHeavyAt(40), 40, 5), 40)
  })

  test('returns the most recent qualifying bar when a run confirms', () => {
    const bars = quiet(60)
    bars[37].volume = 4000
    bars[38].volume = 4000
    assert.equal(confirmedAt(volumeStats(bars), 40, 5), 38)
  })

  // Same reason the pane draws dim bars: a continuation day is not a fresh
  // firing, but it is still evidence that volume is behind the move.
  test('a run continuation confirms even though it is not a firing', () => {
    const bars = quiet(60)
    bars[37].volume = 4000
    bars[38].volume = 4000
    const stats = volumeStats(bars)
    assert.equal(stats.thrust[38], false, 'not a firing')
    assert.equal(stats.elevated[38], true, 'but still elevated')
    assert.equal(confirmedAt(stats, 39, 1), 38)
  })

  test('a window of zero asks only about the bar itself', () => {
    assert.equal(confirmedAt(withHeavyAt(39), 40, 0), -1)
    assert.equal(confirmedAt(withHeavyAt(40), 40, 0), 40)
  })
})
