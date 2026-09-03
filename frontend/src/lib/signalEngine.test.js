import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generateSignals } from './signalEngine.js'

// A long drift down then a rally, which produces one 10/50 golden cross. The
// rally's steepness sets the RSI at that cross, which is what these fixtures
// vary — everything else is held still.
function series({ drift = 0.997, slope = 1.012, n = 95, flat = 70 } = {}) {
  const bars = []
  let p = 200
  for (let i = 0; i < n; i++) {
    p *= i < flat ? drift : slope
    bars.push({
      date: new Date(2025, 0, 1 + i).toISOString().slice(0, 10),
      open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1000,
    })
  }
  return bars
}

describe('generateSignals', () => {
  test('returns nearMisses as a separate array, never inside signals', () => {
    const out = generateSignals(series())
    assert.equal(Array.isArray(out.nearMisses), true)
    // The load-bearing guarantee: Instrument.jsx renders any signal that is not
    // type 'buy' as a red SELL marker, so a near-miss leaking into `signals`
    // would paint a rejected cross as a sell call.
    assert.equal(out.signals.every(s => s.type === 'buy' || s.type === 'sell'), true)
    assert.equal(out.signals.some(s => s.type === 'near-miss'), false)
  })

  test('emits a buy, not a near-miss, when the cross clears RSI 50', () => {
    const out = generateSignals(series())
    const buys = out.signals.filter(s => s.type === 'buy')
    assert.equal((buys).length, 1)
    assert.ok((buys[0].rsi) > (50))
    assert.equal((out.nearMisses).length, 0)
  })

  // A steep fall that flattens out. SMA50 still carries the old high prices and
  // keeps sinking while SMA10 levels off on the plateau, so the two cross with
  // price going nowhere — the crossing is real and momentum is absent. This is
  // the shape behind the ZS chart, and before this change it drew nothing.
  function crossWithoutMomentum() {
    const bars = []
    let p = 300
    const push = (i) => bars.push({
      date: new Date(2025, 0, 1 + i).toISOString().slice(0, 10),
      open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1000,
    })
    for (let i = 0; i < 60; i++) { p *= 0.985; push(i) }
    for (let i = 60; i < 105; i++) { p *= 1.0005 * (1 + 0.002 * Math.sin(i * 1.9)); push(i) }
    return bars
  }

  test('records a cross that failed only the RSI gate', () => {
    const out = generateSignals(crossWithoutMomentum())
    // Assert the branch actually fired. Without this the test would pass on a
    // fixture that produces no near-miss at all — which the first draft did.
    assert.equal((out.nearMisses).length, 1)
    const nm = out.nearMisses[0]
    assert.equal(nm.type, 'near-miss')
    assert.equal(nm.reason, 'rsi')
    assert.ok(Math.abs((nm.rsi) - (42.3)) < 0.05, `expected ~42.3, got ${nm.rsi}`)
    // The defining property: the gate is what rejected it...
    assert.ok((nm.rsi) <= (50))
    // ...and the cross itself is real, so the tooltip's claim holds.
    assert.ok((nm.fast) > (nm.slow))
    // It is a rejection, so it must not appear as a buy anywhere.
    assert.equal((out.signals.filter(s => s.type === 'buy')).length, 0)
  })

  test('never files the same bar as both a buy and a near-miss', () => {
    for (const slope of [1.002, 1.004, 1.008, 1.012, 1.02]) {
      const out = generateSignals(series({ slope }))
      const buyIdx = new Set(out.signals.filter(s => s.type === 'buy').map(s => s.index))
      for (const nm of out.nearMisses) assert.equal(buyIdx.has(nm.index), false)
    }
  })

  // Near-misses must not change what the rule does. This is the regression that
  // would matter most: adding the branch is only safe if the buy/sell sets are
  // byte-for-byte what they were.
  test('leaves the buy and sell sets unchanged', () => {
    const out = generateSignals(series())
    assert.equal((out.signals.filter(s => s.type === 'buy')).length, 1)
    // A death cross with RSI < 50 still fires; the new branch sits after it.
    const down = generateSignals(series({ drift: 1.01, slope: 0.985, flat: 50, n: 110 }))
    assert.equal(down.signals.some(s => s.type === 'sell'), true)
  })

  test('is quiet on a series too short for a slow SMA', () => {
    const out = generateSignals(series({ n: 30 }))
    assert.equal((out.signals).length, 0)
    assert.equal((out.nearMisses).length, 0)
  })
})

// ─── The standalone dead-cat bounce ──────────────────────────────────────────
//
// Same three properties the backend detector is tested on, because the markers
// drawn from this array carry the badge scored from that detector: if the two
// rules drift apart, the badge describes bars that are not on screen.

/** Flat, then a hard fall, then whatever `after` says. */
function dropped(after, { flat = 40, from = 100, to = 82, legs = 8 } = {}) {
  const closes = []
  for (let i = 0; i < flat; i++) closes.push(from)
  for (let i = 1; i <= legs; i++) closes.push(from - ((from - to) * i) / legs)
  closes.push(...after)
  return closes.map((c, i) => ({
    date: new Date(2025, 0, 1 + i).toISOString().slice(0, 10),
    open: c, high: c * 1.002, low: c * 0.998, close: c, volume: 1000,
  }))
}

describe('deadCatBounces', () => {
  test('flags the first up day inside a sharp drop', () => {
    const out = generateSignals(dropped([83]))
    assert.equal(out.deadCatBounces.length, 1)
    const b = out.deadCatBounces[0]
    assert.equal(b.index, dropped([83]).length - 1)
    assert.ok(b.dropPct >= 10, `drop was ${b.dropPct}%`)
    assert.ok(b.close < b.mid, 'still under the 20-bar mean')
  })

  test('a run of green days is ONE marker, not four', () => {
    const out = generateSignals(dropped([83, 84, 85, 86]))
    assert.equal(out.deadCatBounces.length, 1)
  })

  test('a down day between rallies makes the second one a fresh marker', () => {
    const out = generateSignals(dropped([83, 82, 83.5]))
    assert.equal(out.deadCatBounces.length, 2)
  })

  test('a shallow dip is not a dead cat', () => {
    const out = generateSignals(dropped([97], { to: 96 }))
    assert.equal(out.deadCatBounces.length, 0)
  })

  // The same guarantee nearMisses carries: Instrument.jsx and UsInstrument.jsx
  // paint anything inside `signals` as a buy or a sell, so a bearish flag in
  // there would render as a sell call nobody made.
  test('never leaks into signals', () => {
    const out = generateSignals(dropped([83, 84, 85]))
    for (const s of out.signals) assert.notEqual(s.type, 'dead-cat-bounce')
  })
})
