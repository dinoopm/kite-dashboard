import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  directionWord, confidenceConstraint, signalTriad, countdown, explain,
  whatWouldChange, freshnessStatus, sixMonthRead, interpretIndicator, contextReason,
} from './macroRead.js'

// The live payload from 2026-08-09, trimmed. Real numbers on purpose: the
// wording is derived from them, so a fixture with tidy invented values would
// not catch the mistake this module exists to prevent.
const MONITOR = {
  composite: {
    score: -0.0581, regime: 'neutral', bias: 'hold-compatible', coverage: 1,
    contributions: [
      { key: 'inflation', weight: 0.45, score: 0.300, contribution: 0.1350 },
      { key: 'labour', weight: 0.25, score: -0.314, contribution: -0.0786 },
      { key: 'wages', weight: 0.15, score: -1.0, contribution: -0.1500 },
      { key: 'expectations', weight: 0.10, score: -0.146, contribution: -0.0146 },
      { key: 'oil', weight: 0.05, score: 1.0, contribution: 0.0500 },
    ],
  },
  confidence: { level: 'medium', score: 0.684, freshness: 0.833, completeness: 1, agreement: 0.336 },
  signals: {
    inflation: { score: 0.3, detail: { annualized6m: 3.7567, annualized3m: 2.8851 } },
    labour: { score: -0.314, detail: { avg3mChangeThousands: 20, unemploymentChangePp: -0.2 } },
    wages: { score: -1, detail: { yoyPct: 3.153 } },
    expectations: { score: -0.146, detail: { latest: 2.28, changePp: 0.1 } },
    oil: { score: 1, detail: { roc6mPct: 30.88 } },
  },
  releases: { next: { title: 'CPI (Inflation) Report', date: '2026-08-12', daysAway: 2 } },
  thresholds: {
    inflation: { cool6m: 2.0, hot6m: 3.5 },
    labour: { payrollsCool: 50, payrollsHot: 200 },
    wages: { yoyCool: 3.5, yoyHot: 4.5 },
    expectations: { levelCool: 2.15, levelHot: 2.60 },
    oil: { rocCool: -15, rocHot: 25 },
  },
}

describe('directionWord', () => {
  test('a score near zero reads as slight, not as nothing', () => {
    assert.equal(directionWord(-0.0581), 'Slightly cooling')
    assert.equal(directionWord(0.04), 'Slightly re-accelerating')
  })

  test('escalates with distance from the middle', () => {
    assert.equal(directionWord(-0.18), 'Cooling')
    assert.equal(directionWord(0.4), 'Firmly re-accelerating')
    assert.equal(directionWord(-0.8), 'Strongly cooling')
  })

  test('says so when there is no score', () => {
    assert.equal(directionWord(null), 'No reading')
  })
})

describe('confidenceConstraint', () => {
  // The number a glance misses. Three percentages side by side make the reader
  // hunt for the weak one; naming it is the whole value.
  test('names the weakest dimension, not the average', () => {
    const c = confidenceConstraint(MONITOR.confidence)
    assert.equal(c.key, 'agreement')
    assert.match(c.text, /disagree/)
  })

  test('says everything is fine when nothing is weak', () => {
    const c = confidenceConstraint({ freshness: 0.95, completeness: 1, agreement: 0.9 })
    assert.equal(c.key, null)
  })

  test('picks freshness when that is the binding one', () => {
    assert.equal(confidenceConstraint({ freshness: 0.2, completeness: 1, agreement: 0.9 }).key, 'freshness')
  })
})

describe('signalTriad', () => {
  // The reason this is derived rather than written. A plausible hand-written
  // line for this exact payload was "inflation pressure, offset by a cooling
  // labour market" — but labour contributes -0.079 and wages -0.150. The main
  // offset is wage moderation, and it is LARGER than the pressure, which is
  // why the composite is below zero at all.
  test('finds the true main offset, which is not the intuitive one', () => {
    const t = signalTriad(MONITOR)
    assert.equal(t.pressure.key, 'inflation')
    assert.equal(t.offset.key, 'wages', 'labour looks like the offset but is only third by magnitude')
    assert.ok(Math.abs(t.offset.value) > Math.abs(t.pressure.value), 'the offset outweighs the pressure here')
  })

  test('carries the next release as the forward risk', () => {
    assert.equal(signalTriad(MONITOR).risk.title, 'CPI (Inflation) Report')
  })

  test('survives a payload with nothing scored', () => {
    const t = signalTriad({ composite: { contributions: [] } })
    assert.equal(t.pressure, null)
    assert.equal(t.offset, null)
    assert.equal(t.risk, null)
  })
})

describe('countdown', () => {
  test('reads naturally near the date', () => {
    assert.equal(countdown(0), 'today')
    assert.equal(countdown(1), 'tomorrow')
    assert.equal(countdown(2), 'in 2 days')
  })

  test('returns nothing without a number, rather than "in null days"', () => {
    assert.equal(countdown(null), null)
  })
})

describe('explain', () => {
  const text = explain(MONITOR)

  test('names both sides of the current reading', () => {
    assert.match(text, /core inflation/i)
    assert.match(text, /wage growth/i)
  })

  // On the live payload the two sides differ by 0.015 on contributions of
  // ~0.14, which is genuinely balanced — so it must say that rather than
  // declaring a winner off a rounding-scale difference.
  test('calls the live reading balanced rather than picking a side', () => {
    assert.match(text, /close to balanced/)
  })

  test('names the dominant side once the gap is real', () => {
    const lopsided = explain({
      ...MONITOR,
      composite: { ...MONITOR.composite, contributions: [
        { key: 'inflation', contribution: 0.05 }, { key: 'wages', contribution: -0.30 },
      ] },
    })
    assert.match(lopsided, /below zero/)
  })

  test('warns that a near-zero score here is conflict, not calm', () => {
    assert.match(text, /disagree/)
  })

  test('names the next catalyst with a live countdown', () => {
    assert.match(text, /CPI \(Inflation\) Report lands in 2 days/)
  })

  // The panel is a bias read from seven series. A test rather than a
  // convention, because prose drifts.
  test('never asserts a central-bank action', () => {
    const banned = ['will hike', 'will cut', 'will raise', 'expect the fed', 'fed will', 'forecast', 'prediction', 'guarantee', 'certainly']
    const lower = text.toLowerCase()
    for (const b of banned) assert.ok(!lower.includes(b), `explanation contains "${b}"`)
  })

  test('degrades to a plain statement when there is no score', () => {
    assert.match(explain({ composite: { score: null } }), /Not enough current data/)
  })

  // Everything quiet and strong forces cancelling both give ~0. They are
  // different situations and must not produce the same sentence.
  test('distinguishes balanced forces from a quiet reading', () => {
    const balanced = explain({
      ...MONITOR,
      composite: { ...MONITOR.composite, contributions: [
        { key: 'inflation', contribution: 0.20 }, { key: 'wages', contribution: -0.21 },
      ] },
    })
    assert.match(balanced, /close to balanced/)
  })
})

describe('whatWouldChange', () => {
  const lines = whatWouldChange(MONITOR)

  test('states conditions against the thresholds actually in use', () => {
    assert.ok(lines.length >= 3)
    assert.ok(lines.some(l => l.includes('3.76') && l.includes('3.50')), 'should quote the current value and its marker')
  })

  test('frames everything as data conditions, never as policy outcomes', () => {
    const lower = lines.join(' ').toLowerCase()
    for (const b of ['will hike', 'will cut', 'the fed', 'rate decision']) {
      assert.ok(!lower.includes(b), `contains "${b}"`)
    }
  })

  test('returns nothing rather than guessing when thresholds are absent', () => {
    assert.deepEqual(whatWouldChange({ signals: MONITOR.signals }), [])
  })
})

describe('freshnessStatus', () => {
  test('context-only wins over being behind', () => {
    const s = freshnessStatus({ scored: false, releasesBehind: 1 })
    assert.equal(s.label, 'Context only', 'an unscored series being behind is not a problem to act on')
  })

  test('distinguishes fresh, one behind, and stale', () => {
    assert.equal(freshnessStatus({ scored: true, releasesBehind: 0 }).label, 'Fresh')
    assert.equal(freshnessStatus({ scored: true, releasesBehind: 1 }).label, 'One release behind')
    assert.equal(freshnessStatus({ scored: true, releasesBehind: 4 }).label, 'Stale')
  })
})

describe('sixMonthRead', () => {
  // A bare "six-month" label is what this whole panel exists to avoid: the same
  // "+0.7" means three different things across these series.
  test('always names the calculation that produced the number', () => {
    assert.deepEqual(sixMonthRead({ transform: 'index', annualized6m: 3.7567 }), { value: '+3.76%', label: '6m annualized' })
    assert.deepEqual(sixMonthRead({ transform: 'rate', changePp: -0.2 }), { value: '-0.20pp', label: '6m change' })
    assert.deepEqual(sixMonthRead({ transform: 'price', rocPct: 30.88 }), { value: '+30.88%', label: '6m percent change' })
    assert.deepEqual(sixMonthRead({ transform: 'count', avg3mChange: 20 }), { value: '+20k', label: '3m average per month' })
  })

  test('says there is no reading rather than showing a bare dash', () => {
    assert.equal(sixMonthRead({ transform: 'index' }).label, 'no six-month reading')
  })
})

describe('interpretIndicator', () => {
  const T = MONITOR.thresholds

  test('reads core inflation against its markers', () => {
    assert.match(interpretIndicator({ key: 'corePce', annualized6m: 3.7567 }, T), /Above target/)
    assert.match(interpretIndicator({ key: 'coreCpi', annualized6m: 2.58 }, T), /Near target/)
  })

  // Strong hiring is inflationary here, not "good news" — the sign convention
  // that is easiest to get backwards.
  test('reads a tight labour market as tightening, not as strength', () => {
    assert.match(interpretIndicator({ key: 'payrolls', avg3mChange: 260 }, T), /tightening/i)
    assert.match(interpretIndicator({ key: 'wages', yoyPct: 3.153 }, T), /scored basis/, 'wages are scored on YoY but displayed as 6m annualized — the basis must be named')
    assert.match(interpretIndicator({ key: 'payrolls', avg3mChange: 20 }, T), /moderating/i)
  })

  test('reads unemployment direction correctly', () => {
    assert.match(interpretIndicator({ key: 'unemployment', changePp: 0.4 }, T), /loosening/)
    assert.match(interpretIndicator({ key: 'unemployment', changePp: -0.2 }, T), /tightening/)
  })

  test('returns a no-reading string rather than blank when data is missing', () => {
    assert.equal(interpretIndicator({ key: 'corePce' }, T), 'No current reading')
  })
})

describe('contextReason', () => {
  test('always explains why an unscored series is unscored', () => {
    assert.match(contextReason({ key: 'expectationsSurvey', scored: false, releasesBehind: 1 }), /never scored/)
    assert.match(contextReason({ key: 'headlineCpi', scored: false }), /double-count/)
  })

  test('says nothing for a scored series', () => {
    assert.equal(contextReason({ key: 'corePce', scored: true }), null)
  })
})
