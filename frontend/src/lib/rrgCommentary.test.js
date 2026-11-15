import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  quadrantOf, compassOf, headlineFor, ratioTrend, tailWindow, quadrantTenure, crossingsIn, axisTurn, paceOf,
  describeTail, buildRotationCommentary, summarizeRotation, weekInProgress, SORTS,
} from './rrgCommentary.js'

const week = (i) => new Date(Date.UTC(2026, 7, 7 + i * 7)).toISOString().slice(0, 10)
const series = (pts) => pts.map(([rsRatio, rsMomentum], i) => ({ date: week(i), rsRatio, rsMomentum }))

// Shapes lifted from the US sector RRG this was built against.
// Semiconductors: deep in Weakening, sliding down-left the whole window.
const semis = series([[124.3, 94.6], [122.5, 93.4], [121.6, 92.6], [120.2, 91.9], [117.6, 90.0], [114.9, 88.2], [112.7, 86.9], [109.1, 84.6], [106.2, 83.1]])
// Industrials: Weakening into Lagging two weeks before the end, still sliding.
const industrials = series([[100.3, 97.8], [99.6, 97.4], [98.4, 96.8], [96.4, 96.0], [95.0, 95.4], [94.3, 95.3]])
// Health Care: Leading, still moving up-right.
const health = series([[100.8, 103.4], [101.5, 104.0], [103.6, 106.2], [104.6, 106.9], [106.3, 107.7], [107.5, 108.5]])

describe('quadrantOf / compassOf', () => {
  test('100 on an axis counts as the strong side, matching the backend', () => {
    assert.equal(quadrantOf(100, 100), 'Leading')
    assert.equal(quadrantOf(100, 99.99), 'Weakening')
    assert.equal(quadrantOf(99.99, 100), 'Improving')
    assert.equal(quadrantOf(99, 99), 'Lagging')
  })
  test('names screen directions, not destinations', () => {
    assert.equal(compassOf(1, 1), 'up-right')
    assert.equal(compassOf(-1, -1), 'down-left')
    assert.equal(compassOf(1, -1), 'down-right')
    assert.equal(compassOf(-1, 1), 'up-left')
  })
  // Straight up has a flat RS-Ratio. A four-way compass called this up-right
  // and the headline then claimed relative strength had risen.
  test('a move along one axis is named straight, not diagonal', () => {
    assert.equal(compassOf(0, 0.7), 'up')
    assert.equal(compassOf(0.1, 0.7), 'up')
    assert.equal(compassOf(-2, 0.2), 'left')
    assert.equal(compassOf(0.3, -3), 'down')
  })
})

describe('headlineFor', () => {
  const SIDES = ['ahead', 'behind']
  const SPEEDS = ['faster', 'slower', 'steady', 'started', null]
  const all = () => SIDES.flatMap(side => [
    ...['up', 'down'].flatMap(dir => SPEEDS.map(speed => ({ side, dir, speed, h: headlineFor(side, dir, speed) }))),
    ...['flat', 'still'].map(dir => ({ side, dir, speed: null, h: headlineFor(side, dir) })),
  ])

  test('there is a headline for every side, direction and speed', () => {
    for (const { side, dir, speed, h } of all()) assert.ok(typeof h === 'string' && h.length > 10, `${side}:${dir}:${speed}`)
  })

  test('opens with the side in plain words and never names an RRG coordinate', () => {
    for (const { side, dir, speed, h } of all()) {
      assert.match(h, side === 'ahead' ? /^(Still )?[Bb]eating \{B\}/ : /^Behind \{B\}/, `${side}:${dir}:${speed} — ${h}`)
      assert.doesNotMatch(h, /momentum|relative strength|axes|axis|RS-/i, h)
    }
  })

  test('says nothing about speed when none was measured', () => {
    for (const side of SIDES) for (const dir of ['up', 'down']) {
      assert.doesNotMatch(headlineFor(side, dir, null), /faster|slowly|pace|started/, `${side}:${dir}`)
    }
  })
})

describe('ratioTrend', () => {
  const at = (rs) => series(rs.map(r => [r, 100]))
  test('compares the last two weeks with the two before', () => {
    assert.equal(ratioTrend(at([100, 101, 102, 104, 106]), 4, 2).speed, 'faster')   // +4 after +2
    assert.equal(ratioTrend(at([100, 102, 104, 105, 106]), 4, 2).speed, 'slower')   // +2 after +4
    assert.equal(ratioTrend(at([100, 101, 102, 103, 104.2]), 4, 2).speed, 'steady') // +2.2 after +2
    assert.equal(ratioTrend(at([110, 108, 106, 103, 100]), 4, 2).speed, 'faster')   // −6 after −4
  })
  test('a move that follows a flat or opposite stretch has only started', () => {
    assert.equal(ratioTrend(at([104, 102, 100, 101, 102]), 4, 2).speed, 'started')
    assert.equal(ratioTrend(at([100, 100, 100, 101, 102]), 4, 2).speed, 'started')
  })
  test('makes no speed claim without four weeks behind it, or over one step', () => {
    assert.equal(ratioTrend(at([100, 101, 103]), 2, 2).speed, null)
    assert.equal(ratioTrend(at([100, 101, 102, 104, 106]), 4, 1).speed, null)
  })
  test('a change under the flat threshold is flat, whatever its sign', () => {
    const t = ratioTrend(at([100, 100, 100, 100.05, 100.1]), 4, 2, 0.2)
    assert.deepEqual([t.dir, t.speed], ['flat', null])
  })
})

// The guard the old wording lacked. It used to be checked against a rule
// ("both coordinates falling means faster"), and the rule was wrong about the
// data a third to half of the time. This walks deterministic pseudo-random
// tails and checks every word of every headline against RS-Ratio's own steps.
describe('headline words are true of RS-Ratio', () => {
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5 }
  test('direction and speed words match the numbers, over 400 tails', () => {
    for (let n = 0; n < 400; n++) {
      let r = 100 + rnd() * 20, m = 100 + rnd() * 10, vr = rnd(), vm = rnd()
      const pts = []
      for (let i = 0; i < 12; i++) { vr = vr * 0.6 + rnd() * 2; vm = vm * 0.6 + rnd() * 2; r += vr; m += vm; pts.push([+r.toFixed(2), +m.toFixed(2)]) }
      const s = series(pts)
      const read = describeTail(s, { tailLength: 8, benchmark: 'SPY' })
      const h = read.headline
      const e = s.length - 1
      const dx = s[e].rsRatio - s[e - 2].rsRatio
      const before = (s[e - 2].rsRatio - s[e - 4].rsRatio) * Math.sign(dx)
      if (/growing|closing the gap/.test(h)) assert.ok(dx > 0, `${h} — dx ${dx}`)
      if (/shrinking|widening/.test(h)) assert.ok(dx < 0, `${h} — dx ${dx}`)
      if (/held steady/.test(h)) assert.equal(dx, 0, h)
      if (/faster than/.test(h)) assert.ok(before > 0 && Math.abs(dx) >= 1.25 * before, `${h} — ${dx} after ${before}`)
      if (/more slowly than/.test(h)) assert.ok(before > 0 && Math.abs(dx) <= before / 1.25, `${h} — ${dx} after ${before}`)
      if (/started/.test(h)) assert.ok(before <= 0, `${h} — ${dx} after ${before}`)
      assert.match(h, s[e].rsRatio >= 100 ? /^(Still b|B)eating SPY/ : /^Behind SPY/, h)
    }
  })
})

describe('tailWindow', () => {
  // Commentary that read a different window from the chart would describe a
  // line the user is not looking at.
  test('matches the chart: last N points, or N points ending at the scrub index', () => {
    assert.deepEqual(tailWindow(semis, 3, null).tail.map(p => p.rsRatio), [112.7, 109.1, 106.2])
    assert.deepEqual(tailWindow(semis, 3, 4).tail.map(p => p.rsRatio), [121.6, 120.2, 117.6])
    assert.equal(tailWindow(semis, 3, 99).endIdx, semis.length - 1)
    assert.equal(tailWindow(semis, 50, null).tail.length, semis.length)
  })
})

describe('quadrant tenure and crossings', () => {
  test('counts the run back through the whole series and flags when it hit the start', () => {
    assert.deepEqual(quadrantTenure(semis, semis.length - 1), { count: 9, atLeast: true })
    assert.deepEqual(quadrantTenure(industrials, industrials.length - 1), { count: 5, atLeast: false })
  })
  test('lists every change with weeks counted back from the tail end', () => {
    assert.deepEqual(crossingsIn(industrials), [{ from: 'Weakening', to: 'Lagging', weeksAgo: 4 }])
    assert.deepEqual(crossingsIn(health), [])
  })
})

describe('axisTurn', () => {
  // One opposite step after a single move is a wiggle, not a turn.
  test('needs a run of two or more before the reversal', () => {
    const s = series([[100, 100], [100, 99], [100, 98], [100, 97], [100, 97.5]])
    assert.deepEqual(axisTurn(s, 4, 'rsMomentum'), { axis: 'rsMomentum', dir: 'up', weeks: 1, after: 3 })
    const wiggle = series([[100, 100], [100, 101], [100, 100.5], [100, 101]])
    assert.equal(axisTurn(wiggle, 3, 'rsMomentum'), null)
  })
  test('no turn while the axis keeps going the same way', () => {
    assert.equal(axisTurn(semis, semis.length - 1, 'rsMomentum'), null)
  })
  test('still names a turn two or three weeks old, then lets it become the trend', () => {
    const s = series([[100, 100], [100, 99], [100, 98], [100, 97], [100, 98], [100, 99]])
    assert.deepEqual(axisTurn(s, 5, 'rsMomentum'), { axis: 'rsMomentum', dir: 'up', weeks: 2, after: 3 })
    const old = series([[100, 100], [100, 99], [100, 98], [100, 97], [100, 98], [100, 99], [100, 100], [100, 101]])
    assert.equal(axisTurn(old, 7, 'rsMomentum'), null)
  })
  // Industrials' RS-Ratio went 94.3 → 94.2 → 94.3 after ten weeks of ~0.6-point
  // falls. A 0.1 tick is flat, not "relative strength turned up".
  test('a tick far smaller than the usual weekly move is flat, not a turn', () => {
    assert.equal(axisTurn(series([[100.3, 0], [99.6, 0], [98.8, 0], [98.0, 0], [97.0, 0], [96.2, 0], [95.4, 0], [94.3, 0], [94.2, 0], [94.3, 0]]), 9, 'rsRatio'), null)
  })
})

describe('paceOf', () => {
  test('needs five points so there are two steps on each side', () => {
    assert.equal(paceOf(semis.slice(0, 4)), null)
  })
  test('accelerating when the last two steps are 1.5x the earlier ones', () => {
    const s = series([[100, 100], [100.5, 100], [101, 100], [101.5, 100], [103, 100], [104.5, 100]])
    assert.equal(paceOf(s), 'accelerating')
  })
  test('slowing on the mirror image', () => {
    const s = series([[100, 100], [102, 100], [104, 100], [106, 100], [106.5, 100], [107, 100]])
    assert.equal(paceOf(s), 'slowing')
  })
})

describe('describeTail', () => {
  test('a sector still ahead but sliding on both axes', () => {
    const r = describeTail(semis, { tailLength: 12, benchmark: 'SPY' })
    assert.equal(r.quadrant, 'Weakening')
    assert.equal(r.heading.compass, 'down-left')
    // −6.5 over the last two weeks against −4.9 over the two before.
    assert.equal(r.headline, 'Still beating SPY, but the lead is shrinking faster than in the two weeks before.')
    assert.equal(r.ratio.speed, 'faster')
    assert.equal(+r.delta.rsRatio.toFixed(1), -18.1)
    assert.equal(r.weeks, 8)
    assert.match(r.facts[0].text, /In Weakening for 9\+ weeks/)
  })

  test('a straight-up move does not claim relative strength rose', () => {
    const flatRatio = series([[96, 95], [95, 94.5], [94, 94], [94, 94.5], [94, 95.2]])
    const r = describeTail(flatRatio, { tailLength: 12, benchmark: 'SPY' })
    assert.equal(r.heading.compass, 'up')
    assert.equal(r.headline, 'Behind SPY; the gap held steady.')
    assert.match(r.facts.find(f => f.kind === 'turn').text, /Momentum has risen for 2 weeks after falling for 2 weeks/)
  })

  test('a fresh crossing is the first fact, and the headline says behind', () => {
    const r = describeTail(industrials, { tailLength: 12, benchmark: 'SPY' })
    assert.equal(r.quadrant, 'Lagging')
    assert.match(r.headline, /^Behind SPY/)
    assert.equal(r.facts[0].kind, 'crossing')
    assert.match(r.facts[0].text, /Moved from Weakening into Lagging 4 weeks ago/)
  })

  // The guardrail: this is commentary on a signal with no track record, so it
  // must never phrase rotation as something that will happen.
  test('never speaks in the future tense', () => {
    for (const s of [semis, industrials, health]) {
      const r = describeTail(s, { tailLength: 12, benchmark: 'SPY' })
      for (const line of [r.headline, ...r.facts.map(f => f.text)]) {
        assert.doesNotMatch(line, /\bwill\b|\bshould\b|\bexpect|\blikely\b|\bnext\b/i, line)
      }
    }
  })

  test('scales "barely moving" to the group, not to an absolute number', () => {
    const tiny = series([[100.5, 100.5], [100.52, 100.52], [100.54, 100.54]])
    const r = describeTail(tiny, { tailLength: 12, benchmark: 'SPY', group: { typicalStep: 2 } })
    assert.equal(r.heading.compass, 'still')
    assert.match(r.headline, /little change lately/)
    // Without a group yardstick it keeps its direction.
    assert.equal(describeTail(tiny, { tailLength: 12 }).heading.compass, 'up-right')
  })

  test('a one-point window says so rather than inventing a direction', () => {
    const r = describeTail(health, { tailLength: 1, benchmark: 'SPY' })
    assert.equal(r.heading, null)
    assert.match(r.headline, /only one week/)
  })

  test('reads the scrubbed window, not the latest one', () => {
    const r = describeTail(industrials, { tailLength: 3, scrubEnd: 1, benchmark: 'SPY' })
    assert.equal(r.latest.rsRatio, 99.6)
    assert.equal(r.quadrant, 'Lagging')
    assert.match(r.facts[0].text, /Moved from Weakening into Lagging in the latest week/)
  })
})

describe('buildRotationCommentary + summarizeRotation', () => {
  const sectors = [
    { key: 'SMH', name: 'Semiconductors', series: semis },
    { key: 'XLI', name: 'Industrials', series: industrials },
    { key: 'XLV', name: 'Health Care', series: health },
    { key: 'EMPTY', name: 'No data', series: [] },
  ]
  const { reads } = buildRotationCommentary(sectors, { tailLength: 12, benchmark: 'SPY' })

  test('skips sectors with no points and keeps keys and names', () => {
    assert.deepEqual(reads.map(r => r.key), ['SMH', 'XLI', 'XLV'])
  })

  test('counts, ahead-of-benchmark, strongest and biggest move', () => {
    const s = summarizeRotation(reads)
    assert.deepEqual(s.counts, { Leading: 1, Weakening: 1, Lagging: 1, Improving: 0 })
    assert.equal(s.ahead, 2)
    assert.equal(s.strongest.key, 'XLV')
    assert.equal(s.weakest.key, 'XLI')
    assert.equal(s.biggestMove.key, 'SMH')
  })

  test('fresh crossings only count the last week or so', () => {
    assert.deepEqual(summarizeRotation(reads).fresh, [])
    const late = buildRotationCommentary([{ key: 'XLI', name: 'Industrials', series: industrials }], { tailLength: 3, scrubEnd: 1 }).reads
    assert.equal(summarizeRotation(late).fresh.length, 1)
  })

  test('sorts: rotation order, then biggest movers', () => {
    assert.deepEqual([...reads].sort(SORTS.rotation).map(r => r.key), ['XLV', 'SMH', 'XLI'])
    assert.deepEqual([...reads].sort(SORTS.movers).map(r => r.key)[0], 'SMH')
  })
})

describe('weekInProgress', () => {
  const wed = new Date(2026, 10, 11, 15)
  test('a Friday key later this week is still being traded', () => {
    assert.equal(weekInProgress('2026-11-13', wed), true)
  })
  test('last Friday is a closed bar', () => {
    assert.equal(weekInProgress('2026-11-06', wed), false)
  })
})
