import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { growthPill, expensePill, marginPill, cashflowPill, signChangePill, profitYoYSummary } from './growthPill.js'

describe('growthPill', () => {
  test('reports ordinary growth as a signed percentage', () => {
    assert.equal(growthPill(110, 100).label, '↑10.0%')
    assert.equal(growthPill(90, 100).label, '↓10.0%')
  })

  test('colours louder as the move gets bigger', () => {
    assert.notEqual(growthPill(102, 100).color, growthPill(150, 100).color)
    assert.equal(growthPill(150, 100).weight, 800)
  })

  test('returns nothing when a side is missing or the base is zero', () => {
    assert.equal(growthPill(null, 100), null)
    assert.equal(growthPill(100, null), null)
    assert.equal(growthPill(100, 0), null, 'division by zero is not a 100% gain')
  })

  // The Tata Power defect: −160 → 334 rendered as "↑308.8%" in deep green,
  // which reads as an explosive quarter rather than a return to profit.
  test('never invents a percentage from a loss', () => {
    const p = growthPill(334, -160)
    assert.equal(p.label, 'loss → profit')
    assert.equal(p.qualitative, true)
    assert.doesNotMatch(p.label, /%/, 'no percentage may be shown off a negative base')
    assert.doesNotMatch(p.label, /308/)
  })

  test('calls a slide into loss what it is', () => {
    const p = growthPill(-160, 431)
    assert.equal(p.label, 'profit → loss')
    assert.doesNotMatch(p.label, /%/)
  })

  test('treats a shrinking loss as an improvement', () => {
    const better = growthPill(-50, -160)
    const worse = growthPill(-300, -160)
    assert.equal(better.label, 'loss narrower')
    assert.equal(worse.label, 'loss wider')
    assert.notEqual(better.color, worse.color)
  })

  // Same magnitudes, opposite base signs — the old code gave both a number.
  test('a tiny loss turning positive does not outrank real growth', () => {
    const fromTinyLoss = growthPill(100, -1)
    const realGrowth = growthPill(200, 100)
    assert.equal(fromTinyLoss.qualitative, true)
    assert.match(realGrowth.label, /↑100\.0%/)
  })

  test('breakeven at exactly zero is still a return to profit', () => {
    assert.equal(growthPill(0, -50).label, 'loss → profit')
  })
})

describe('expensePill', () => {
  test('uses signs rather than arrows, and inverts the polarity', () => {
    const rising = expensePill(110, 100)
    const falling = expensePill(90, 100)
    assert.equal(rising.label, '+10.0%')
    assert.equal(falling.label, '−10.0%')
    assert.notEqual(rising.color, falling.color)
  })

  test('rising expenses read as bad, falling as good', () => {
    assert.equal(expensePill(150, 100).color, expensePill(50, 200).color === '#059669' ? '#dc2626' : expensePill(150, 100).color)
    assert.equal(expensePill(50, 200).color, '#059669', 'a big cost cut is deep green')
    assert.equal(expensePill(150, 100).color, '#dc2626', 'a big cost rise is deep red')
  })

  // Regression: the old version parsed a number out of the label, so a
  // qualitative pill became NaN%.
  test('passes a qualitative pill through untouched', () => {
    const p = expensePill(334, -160)
    assert.equal(p.label, 'loss → profit')
    assert.doesNotMatch(p.label, /NaN/)
  })

  test('returns nothing when growthPill does', () => {
    assert.equal(expensePill(100, 0), null)
    assert.equal(expensePill(null, 100), null)
  })
})

describe('marginPill', () => {
  test('measures margins in percentage points, not relative change', () => {
    assert.equal(marginPill(22, 19).label, '+3.0 pp')
    assert.equal(marginPill(13, 22).label, '−9.0 pp')
  })

  test('a flat margin reads as zero, not as missing', () => {
    assert.equal(marginPill(19, 19).label, '+0.0 pp')
  })

  // Margins are legitimately negative, and unlike growth the arithmetic still
  // works — a swing from −5% to 2% really is +7 pp.
  test('handles negative margins without special-casing', () => {
    assert.equal(marginPill(2, -5).label, '+7.0 pp')
  })

  test('needs both sides', () => {
    assert.equal(marginPill(null, 19), null)
    assert.equal(marginPill(19, null), null)
  })
})

describe('cashflowPill', () => {
  // Investing and financing lines are negative in a normal year, so a negative
  // base is the rule here rather than the exception.
  test('describes cash direction rather than loss and profit', () => {
    assert.equal(cashflowPill(500, -200).label, 'outflow → inflow')
    assert.equal(cashflowPill(-200, 500).label, 'inflow → outflow')
    assert.equal(cashflowPill(-500, -200).label, 'outflow wider')
    assert.equal(cashflowPill(-100, -200).label, 'outflow narrower')
  })

  test('still gives a percentage when both years were cash-positive', () => {
    assert.equal(cashflowPill(120, 100).label, '↑20.0%')
  })
})

describe('signChangePill', () => {
  test('stays out of the way when both sides are positive', () => {
    assert.equal(signChangePill(110, 100), null)
  })

  test('accepts custom vocabulary', () => {
    assert.equal(signChangePill(10, -10, { neg: 'deficit', pos: 'surplus' }).label, 'deficit → surplus')
  })
})

describe('profitYoYSummary', () => {
  const pairs = (...xs) => xs.map(([curr, prev]) => ({ curr, prev }))

  test('reports an ordinary percentage when every side is positive', () => {
    const s = profitYoYSummary(pairs([120, 100], [141, 293]))
    assert.equal(s.pill, null)
    assert.equal(s.latest.toFixed(1), '-51.9')
    assert.equal(s.considered, 2)
    assert.equal(s.signChanges, 0)
  })

  // The defect this exists to prevent: Q1 FY27 lost ₹27 Cr against a ₹64 Cr
  // loss a year earlier and the card said "NET PROFIT YOY ↑ +57.8%" in green.
  test('shows the transition, not a percentage, when the latest period lost money', () => {
    const s = profitYoYSummary(pairs([180, 293], [-27, -64]))
    assert.equal(s.latest, null, 'no number may be shown off a negative base')
    assert.equal(s.pill.label, 'loss narrower')
    assert.equal(s.signChanges, 1)
  })

  test('a slide from profit into loss is not counted as an improvement', () => {
    const s = profitYoYSummary(pairs([-30, 50]))
    assert.equal(s.wins, 0)
    assert.equal(s.pill.label, 'profit → loss')
    assert.equal(s.latest, null)
  })

  test('a return to profit counts, and still shows no percentage', () => {
    const s = profitYoYSummary(pairs([334, -160]))
    assert.equal(s.wins, 1)
    assert.equal(s.pill.label, 'loss → profit')
    assert.equal(s.latest, null)
  })

  // Counting `pct > 0` off the |prev| ratio scored this quarter as one that
  // "grew", so the caption read "Grew in 1 of last 4 quarters" for a company
  // whose profit never once grew.
  test('a narrowing loss improved but did not grow', () => {
    const s = profitYoYSummary(pairs([-27, -64]))
    assert.equal(s.wins, 1, 'losing less is an improvement')
    assert.ok(s.signChanges > 0, 'and the caller must not call it growth')
  })

  test('a widening loss is neither', () => {
    const s = profitYoYSummary(pairs([-64, -27]))
    assert.equal(s.wins, 0)
    assert.equal(s.pill.label, 'loss wider')
  })

  test('skips periods with no comparable base without shrinking the rest', () => {
    const s = profitYoYSummary(pairs([100, null], [150, 0], [120, 100]))
    assert.equal(s.considered, 1)
    assert.equal(s.latest.toFixed(1), '20.0')
  })

  test('carries the caller vocabulary through to the transition label', () => {
    const s = profitYoYSummary(pairs([-5, -9]), { neg: 'outflow', pos: 'inflow' })
    assert.equal(s.pill.label, 'outflow narrower')
  })
})

describe('profitYoYSummary figures', () => {
  const pairs = (...xs) => xs.map(([curr, prev]) => ({ curr, prev }))

  // Refusing the ratio must not also withhold the amounts — "loss narrower" on
  // its own tells the reader less than the wrong percentage did.
  test('carries both latest amounts through a sign change', () => {
    const s = profitYoYSummary(pairs([180, 293], [-27, -64]))
    assert.equal(s.latestCurr, -27)
    assert.equal(s.latestPrev, -64)
    assert.equal(s.latest, null)
  })

  test('carries them for an ordinary percentage too', () => {
    const s = profitYoYSummary(pairs([141, 293]))
    assert.equal(s.latestCurr, 141)
    assert.equal(s.latestPrev, 293)
  })

  test('leaves them null when no period had a comparable base', () => {
    const s = profitYoYSummary(pairs([100, null], [150, 0]))
    assert.equal(s.latestCurr, null)
    assert.equal(s.latestPrev, null)
    assert.equal(s.considered, 0)
  })
})

describe('profitYoYSummary magnitudePct', () => {
  const pairs = (...xs) => xs.map(([curr, prev]) => ({ curr, prev }))

  // The number the card originally printed as "+57.8% net profit growth". It is
  // a real measurement — of the loss, which shrank by that much — so it is shown
  // under a label that says so rather than suppressed.
  test('measures how much a loss shrank', () => {
    const s = profitYoYSummary(pairs([-27, -64]))
    assert.equal(s.magnitudePct.toFixed(1), '57.8')
    assert.equal(s.pill.label, 'loss narrower')
    assert.equal(s.latest, null, 'still no profit-growth percentage')
  })

  test('is negative when the loss widened', () => {
    const s = profitYoYSummary(pairs([-64, -27]))
    assert.ok(s.magnitudePct < 0)
    assert.equal(s.magnitudePct.toFixed(1), '-137.0')
  })

  // Across zero the base changes sign, so no percentage describes the move.
  test('stays null across a sign flip in either direction', () => {
    assert.equal(profitYoYSummary(pairs([334, -160])).magnitudePct, null)
    assert.equal(profitYoYSummary(pairs([-30, 50])).magnitudePct, null)
  })

  test('stays null when both sides are positive, where `latest` already applies', () => {
    const s = profitYoYSummary(pairs([141, 293]))
    assert.equal(s.magnitudePct, null)
    assert.equal(s.latest.toFixed(1), '-51.9')
  })
})
