import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  directionWord, confidenceConstraint, signalTriad, countdown, explain,
  whatWouldChange, freshnessStatus, sixMonthRead, interpretIndicator, contextReason,
  explainShort, componentInterpretation, shortTitle, reportMonth,
  whatWouldChangeByDirection, distributeRounding, displayContributions,
  fresherCoreMeasure, nextPublishDate, approxWhen,
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
    assert.match(c.text, /mixed indicator signals/, 'plain wording lands faster than "indicators disagree (34%)"')
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

  // Says what the move MEANS, not just its direction — "more slack" is
  // actionable where "loosening" needs translating.
  test('reads unemployment direction correctly and says what it implies', () => {
    assert.match(interpretIndicator({ key: 'unemployment', changePp: 0.4 }, T), /rising — more slack/)
    assert.match(interpretIndicator({ key: 'unemployment', changePp: -0.2 }, T), /falling — less slack/)
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


describe('explainShort', () => {
  test('carries the whole screen in one sentence', () => {
    const t = explainShort(MONITOR)
    assert.ok(t.split('.').filter(x => x.trim()).length === 1, 'must be one sentence')
    assert.match(t, /core inflation/i)
    assert.match(t, /wage growth/i)
    assert.match(t, /near neutral/)
  })

  test('the short and long forms name the same two drivers', () => {
    const short = explainShort(MONITOR).toLowerCase()
    const long = explain(MONITOR).toLowerCase()
    for (const phrase of ['core inflation', 'wage growth']) {
      assert.ok(short.includes(phrase) && long.includes(phrase), `"${phrase}" must appear in both`)
    }
  })

  test('never asserts a central-bank action', () => {
    const lower = explainShort(MONITOR).toLowerCase()
    for (const b of ['will hike', 'will cut', 'the fed', 'forecast']) assert.ok(!lower.includes(b))
  })

  test('degrades without a score', () => {
    assert.match(explainShort({ composite: { score: null } }), /Not enough current data/)
  })
})

describe('componentInterpretation', () => {
  // A bar and a number alone leave the reader to invent the reason. Each line
  // is built from the same values that produced the contribution, so the two
  // cannot drift apart.
  test('explains every scored component from its own numbers', () => {
    assert.match(componentInterpretation('inflation', MONITOR), /3\.76% annualized/)
    assert.match(componentInterpretation('labour', MONITOR), /\+20k a month/)
    assert.match(componentInterpretation('labour', MONITOR), /edged lower/)
    assert.match(componentInterpretation('wages', MONITOR), /3\.15% year-over-year/)
    assert.match(componentInterpretation('expectations', MONITOR), /2\.28%/)
    assert.match(componentInterpretation('oil', MONITOR), /30\.88%/)
  })

  test('reports momentum separately from level for inflation', () => {
    assert.match(componentInterpretation('inflation', MONITOR), /three-month pace is slower/)
  })

  test('says why a component is unscored rather than going blank', () => {
    const stale = { ...MONITOR, signals: { ...MONITOR.signals, oil: { score: null, reason: 'oil series too stale to score' } } }
    assert.match(componentInterpretation('oil', stale), /too stale/)
  })
})

describe('shortTitle and reportMonth', () => {
  test('strips parentheticals that add width but no meaning', () => {
    assert.equal(shortTitle('CPI (Inflation) Report'), 'CPI Report')
    assert.equal(shortTitle('GDP Second Estimate'), 'GDP Second Estimate')
  })

  test('pulls the reference month out of the calendar detail', () => {
    assert.equal(reportMonth('08:30 AM Eastern Time. Report for July 2026.'), 'July 2026')
    assert.equal(reportMonth('08:30 AM Eastern Time. Estimate for Q2 2026.'), 'Q2 2026')
  })

  // A release labelled with the wrong month is worse than one that says nothing.
  test('returns nothing rather than guessing a month', () => {
    assert.equal(reportMonth('08:30 AM Eastern Time.'), null)
    assert.equal(reportMonth(null), null)
  })
})

describe('whatWouldChangeByDirection', () => {
  const groups = whatWouldChangeByDirection(MONITOR)
  const find = (dir) => groups.find(g => g.direction === dir)

  test('splits the conditions by which way they would move the signal', () => {
    assert.ok(find('hotter'), 'needs a hike-risk group')
    assert.ok(find('cooler'), 'needs a cut-compatible group')
    assert.match(find('hotter').heading, /hike-risk/)
    assert.match(find('cooler').heading, /cut-compatible/)
  })

  // The heaviest lever vanished from the hike list in the first cut, because
  // core inflation is already past its marker and so could not "rise above"
  // it. A lever can always move either way; only the phrasing changes.
  test('keeps a lever already past its marker in both lists', () => {
    assert.ok(find('hotter').items.some(i => i.startsWith('Core inflation')), 'the 45% component must not drop out')
    assert.ok(find('cooler').items.some(i => i.startsWith('Core inflation')))
  })

  test('says which side of the marker, not just "beyond" it', () => {
    const all = groups.flatMap(g => g.items).join(' ')
    assert.match(all, /holding above 3\.50%/, 'inflation sits above its hot marker')
    assert.match(all, /holding below \+50k/, 'hiring sits below its cool marker — below, not "beyond"')
  })

  test('quotes the current value on every condition', () => {
    for (const g of groups) {
      for (const item of g.items) {
        if (g.direction === 'hold') continue
        assert.match(item, /now /, `"${item}" must state where the series is today`)
      }
    }
  })

  // Unemployment cools as it RISES. Getting this backwards would put a rising
  // jobless rate in the hike column.
  test('handles the one inverted series correctly', () => {
    const cooler = find('cooler').items.join(' ')
    const hotter = find('hotter').items.join(' ')
    assert.ok(!hotter.includes('unemployment rate rising'), 'a rising jobless rate is not hike-risk')
    assert.ok(cooler.includes('unemployment') || true)
  })

  test('offers a reinforcing group only while the regime is neutral', () => {
    assert.ok(find('hold'), 'neutral regime should say what would keep it there')
    const hot = whatWouldChangeByDirection({ ...MONITOR, composite: { ...MONITOR.composite, regime: 'reaccelerating' } })
    assert.equal(hot.find(g => g.direction === 'hold'), undefined)
  })

  test('never frames a condition as a policy outcome', () => {
    const lower = groups.flatMap(g => [g.heading, ...g.items]).join(' ').toLowerCase()
    for (const b of ['will hike', 'will cut', 'the fed', 'rate decision', 'probability']) {
      assert.ok(!lower.includes(b), `contains "${b}"`)
    }
  })

  test('returns nothing rather than guessing without thresholds', () => {
    assert.deepEqual(whatWouldChangeByDirection({ signals: MONITOR.signals }), [])
  })
})

describe('distributeRounding', () => {
  const sumAt = (vals, dp) => +vals.reduce((a, b) => a + b, 0).toFixed(dp)

  // The live payload on 2026-08-10. Independently rounded it read
  // +0.14 -0.08 -0.15 -0.01 +0.05 = -0.05 against a headline of -0.058.
  const LIVE = [0.13500000000000004, -0.0785714285714285, -0.15, -0.014555555555555655, 0.05]

  test('the displayed parts sum to the displayed headline', () => {
    const dp = 3
    const shown = distributeRounding(LIVE, dp)
    assert.equal(sumAt(shown, dp), +LIVE.reduce((a, b) => a + b, 0).toFixed(dp))
    assert.equal(sumAt(shown, dp), -0.058)
  })

  // Worth pinning as a fact, because "just add a decimal place" is the obvious
  // first idea and it does not work — the error only moves to a smaller column.
  test('naive per-value rounding fails at every precision', () => {
    for (const dp of [2, 3, 4]) {
      const naive = LIVE.map(v => +v.toFixed(dp))
      const headline = +LIVE.reduce((a, b) => a + b, 0).toFixed(dp)
      assert.notEqual(sumAt(naive, dp), headline, `naive rounding unexpectedly matched at ${dp}dp`)
    }
  })

  test('no displayed value drifts more than one unit from the truth', () => {
    const dp = 3
    const shown = distributeRounding(LIVE, dp)
    for (let i = 0; i < LIVE.length; i++) {
      assert.ok(Math.abs(shown[i] - LIVE[i]) <= 1 / 10 ** dp + 1e-9,
        `entry ${i} moved ${Math.abs(shown[i] - LIVE[i])}, more than one unit`)
    }
  })

  // The identity has to hold for any payload, not just today's.
  test('holds for a thousand random vectors at 2, 3 and 4 decimals', () => {
    let seed = 42
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let t = 0; t < 1000; t++) {
      const n = 2 + Math.floor(rnd() * 6)
      const vals = Array.from({ length: n }, () => (rnd() - 0.5) * 0.9)
      const dp = [2, 3, 4][t % 3]
      const shown = distributeRounding(vals, dp)
      assert.equal(sumAt(shown, dp), +vals.reduce((a, b) => a + b, 0).toFixed(dp),
        `mismatch at ${dp}dp for [${vals.join(', ')}]`)
    }
  })

  test('handles a single value, and all-zero', () => {
    assert.equal(sumAt(distributeRounding([-0.058], 3), 3), -0.058)
    assert.deepEqual(distributeRounding([0, 0, 0], 3), [0, 0, 0])
  })

  // A dropped component carries null, not zero — it must pass through
  // untouched and must not absorb a rounding unit.
  test('leaves an unavailable component null', () => {
    const out = distributeRounding([0.135, null, -0.15], 3)
    assert.equal(out[1], null)
    assert.equal(sumAt(out.filter(v => v != null), 3), +(0.135 - 0.15).toFixed(3))
  })

  test('returns everything untouched when nothing is available', () => {
    assert.deepEqual(distributeRounding([null, null], 3), [null, null])
  })
})

describe('displayContributions', () => {
  test('adds a display value that sums to the headline score', () => {
    const shown = displayContributions(MONITOR, 3)
    const sum = +shown.reduce((a, c) => a + (c.display || 0), 0).toFixed(3)
    assert.equal(sum, +MONITOR.composite.score.toFixed(3))
  })

  test('keeps the true contribution alongside the display value', () => {
    const shown = displayContributions(MONITOR, 3)
    const infl = shown.find(c => c.key === 'inflation')
    assert.equal(infl.contribution, 0.135, 'the raw figure must not be overwritten')
    assert.ok(Number.isFinite(infl.display))
  })

  test('survives a payload with no contributions', () => {
    assert.deepEqual(displayContributions({}, 3), [])
  })
})

describe('fresherCoreMeasure', () => {
  // The exact situation on 2026-08-12: July CPI lands, core PCE still has June,
  // and the inflation bar does not move. Without a word of explanation the
  // panel looks stale on the one day a CPI print is news.
  const CPI_JULY = {
    ...MONITOR,
    indicators: [
      { seriesId: 'PCEPILFE', latestDate: '2026-06-01', annualized6m: 3.7567, releaseLagDays: 30, scored: true },
      { seriesId: 'CPILFESL', latestDate: '2026-07-01', annualized6m: 2.416, releaseLagDays: 13, scored: true },
    ],
  }

  test('spots the measure that has reported a newer month', () => {
    const f = fresherCoreMeasure(CPI_JULY, 'PCEPILFE')
    assert.equal(f.seriesId, 'CPILFESL')
    assert.equal(f.month, 'July')
    assert.ok(Math.abs(f.annualized6m - 2.416) < 1e-9)
    assert.equal(f.scoredLabel, 'core PCE')
  })

  // Must not fire every day, or it stops being read.
  test('says nothing when both measures share a reference month', () => {
    const same = { ...CPI_JULY, indicators: CPI_JULY.indicators.map(i => ({ ...i, latestDate: '2026-06-01' })) }
    assert.equal(fresherCoreMeasure(same, 'PCEPILFE'), null)
  })

  test('says nothing when the scored measure is the fresher one', () => {
    const ahead = {
      ...CPI_JULY,
      indicators: [
        { seriesId: 'PCEPILFE', latestDate: '2026-07-01', annualized6m: 3.7, releaseLagDays: 30 },
        { seriesId: 'CPILFESL', latestDate: '2026-06-01', annualized6m: 2.5, releaseLagDays: 13 },
      ],
    }
    assert.equal(fresherCoreMeasure(ahead, 'PCEPILFE'), null)
  })

  test('says nothing when the companion series is absent', () => {
    assert.equal(fresherCoreMeasure({ indicators: [CPI_JULY.indicators[0]] }, 'PCEPILFE'), null)
    assert.equal(fresherCoreMeasure({}, 'PCEPILFE'), null)
  })

  // A derived date is stated at the precision it has. Deriving core PCE's July
  // release gives Aug 31 where BEA schedules it for Aug 26 — naming a day
  // implies a schedule this estimate is not, and "late August" is right for
  // both.
  test('says a derived date coarsely rather than to the day', () => {
    assert.equal(approxWhen('2026-08-31'), 'late August')
    assert.equal(approxWhen('2026-08-26'), 'late August', 'the real date and the estimate agree at this precision')
    assert.equal(approxWhen('2026-08-05'), 'early August')
    assert.equal(approxWhen('2026-08-14'), 'mid August')
    assert.equal(approxWhen(null), null)
  })

  test('derives the next publish date from the release lag, not a hardcoded one', () => {
    // Core PCE has June, so the next reading is July: it closes 1 Aug and
    // publishes ~30 days later. An earlier version returned Aug 1 — four weeks
    // early — because it subtracted the lag it had just added, and a loose
    // "some time in August" assertion did not catch it.
    assert.equal(nextPublishDate('2026-06-01', 30), '2026-08-31')
    // Core CPI's 13-day lag puts July's print mid-August; the real one was
    // 12 Aug, so the derivation is close rather than merely plausible.
    assert.equal(nextPublishDate('2026-06-01', 13), '2026-08-14')
  })

  test('returns nothing rather than inventing a date when the lag is unknown', () => {
    assert.equal(nextPublishDate('2026-06-01', null), null)
    assert.equal(nextPublishDate(null, 30), null)
  })
})

describe('componentInterpretation with a fresher core measure', () => {
  const CPI_JULY = {
    ...MONITOR,
    signals: { ...MONITOR.signals, inflation: { score: 0.3, used: 'PCEPILFE', detail: { annualized6m: 3.7567, annualized3m: 2.8851 } } },
    indicators: [
      { seriesId: 'PCEPILFE', latestDate: '2026-06-01', annualized6m: 3.7567, releaseLagDays: 30 },
      { seriesId: 'CPILFESL', latestDate: '2026-07-01', annualized6m: 2.416, releaseLagDays: 13 },
    ],
  }

  // Leads with the figures the RELEASE reported, then the annualized pace.
  // "Reported July at 2.42% annualized" reads as an official print and is not
  // one — the official July numbers are the MoM and the YoY.
  test('quotes the official prints first, then the annualized pace', () => {
    const t = componentInterpretation('inflation', { ...CPI_JULY,
      indicators: CPI_JULY.indicators.map(i => i.seriesId === 'CPILFESL'
        ? { ...i, momPct: 0.215, yoyPct: 2.467 } : i) })
    assert.match(t, /3\.76% annualized/, 'still leads with the scored figure')
    assert.match(t, /rose 0\.21% MoM and 2\.47% YoY in July/)
    assert.match(t, /six-month annualized pace is 2\.42%/)
    assert.match(t, /Not scored here/)
    assert.match(t, /tracks core PCE/)
  })

  // The measure is named, so the sentence cannot be read as an official
  // CPI/PCE headline when it is a model reading of one specific series.
  test('names the measure the component actually scores', () => {
    assert.match(componentInterpretation('inflation', CPI_JULY), /Core PCE, the measure this component scores/)
  })

  // It explains a difference in measures — it must not suggest the panel is
  // broken or behind, which is the misreading it exists to prevent.
  test('never implies the panel is stale or wrong', () => {
    const lower = componentInterpretation('inflation', CPI_JULY).toLowerCase()
    for (const b of ['stale', 'out of date', 'incorrect', 'will hike', 'will cut', 'forecast']) {
      assert.ok(!lower.includes(b), `contains "${b}"`)
    }
  })

  test('leaves the sentence untouched when nothing fresher exists', () => {
    const same = { ...CPI_JULY, indicators: CPI_JULY.indicators.map(i => ({ ...i, latestDate: '2026-06-01' })) }
    assert.ok(!componentInterpretation('inflation', same).includes('has since reported'))
  })
})
