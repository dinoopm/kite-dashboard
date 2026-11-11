import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { badgePlacement } from './measurementBadge.js'

const W = 1000, H = 480, BW = 280, BH = 100
const box = (from, to) => ({ x0: Math.min(from.x, to.x), x1: Math.max(from.x, to.x), y0: Math.min(from.y, to.y), y1: Math.max(from.y, to.y) })
const overlaps = (p, r, pad = 6) => p.left < r.x1 + pad && p.left + BW > r.x0 - pad && p.top < r.y1 + pad && p.top + BH > r.y0 - pad
const inside = (p) => p.left >= 0 && p.top >= 0 && p.left + BW <= W && p.top + BH <= H
const place = (from, to) => badgePlacement({ from, to, width: W, height: H, badgeWidth: BW, badgeHeight: BH })

describe('badgePlacement', () => {
  // The reported case: a selection whose upper point sits near the top of the
  // plot. The old rule wanted 105px above it, had no room, clamped to the top
  // edge — and landed squarely on the selection it was describing.
  test('never covers a selection that reaches the top of the plot', () => {
    const from = { x: 940, y: 300 }, to = { x: 760, y: 60 }
    const p = place(from, to)
    assert.equal(overlaps(p, box(from, to)), false)
    assert.equal(inside(p), true)
  })

  test('prefers the space above the selection when there is room', () => {
    const p = place({ x: 400, y: 380 }, { x: 600, y: 300 })
    assert.equal(p.side, 'above')
    assert.ok(p.top + BH <= 300)
  })

  test('goes below when there is no room above', () => {
    const from = { x: 400, y: 40 }, to = { x: 600, y: 120 }
    const p = place(from, to)
    assert.equal(p.side, 'below')
    assert.equal(overlaps(p, box(from, to)), false)
  })

  test('goes beside a selection that spans the full height', () => {
    const from = { x: 450, y: 10 }, to = { x: 600, y: 470 }
    const p = place(from, to)
    assert.ok(['left', 'right'].includes(p.side))
    assert.equal(overlaps(p, box(from, to)), false)
    assert.equal(inside(p), true)
  })

  // Nothing fits cleanly: pick the corner that hides the least of it.
  test('falls back to the corner that covers the least of a plot-filling selection', () => {
    const from = { x: 120, y: 20 }, to = { x: 980, y: 470 }
    const p = place(from, to)
    assert.equal(p.side, 'corner')
    assert.equal(inside(p), true)
    assert.equal(p.left, 8, 'the left edge, where the selection starts furthest in')
  })

  test('places a single point (no second click yet) without covering it', () => {
    const p = place({ x: 500, y: 30 }, null)
    assert.equal(overlaps(p, box({ x: 500, y: 30 }, { x: 500, y: 30 })), false)
  })

  test('keeps the badge horizontally inside the plot', () => {
    const p = place({ x: 990, y: 400 }, { x: 960, y: 300 })
    assert.equal(inside(p), true)
  })
})
