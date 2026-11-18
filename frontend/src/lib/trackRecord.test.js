import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { statusOf, mergeScorecards, summarize, sortRows, STATUS_ORDER, STATUS_META } from './trackRecord.js'

const h = (state, text = '') => ({ state, text, detail: '' })

describe('statusOf', () => {
  test('reads the state the scorer already decided', () => {
    for (const s of ['positive', 'negative', 'held', 'refuted']) assert.equal(statusOf(h(s)), 'measured')
    assert.equal(statusOf(h('unscoreable', 'Cannot be scored yet')), 'blocked')
    assert.equal(statusOf(h('thin', 'n=7 — too few to judge')), 'thin')
    assert.equal(statusOf(h('no-data', 'No resolved firings yet')), 'thin')
    assert.equal(statusOf(h('no-benchmark', 'median 1% (no benchmark)')), 'thin')
  })
  // Enough data and nothing there is a finding, not a gap.
  test('"no clear edge" is its own state, not "too few"', () => {
    assert.equal(statusOf(h('thin', 'no clear edge (+0.07%, n=194)')), 'no-edge')
  })
  test('every state has a title and an explanation', () => {
    for (const s of STATUS_ORDER) assert.ok(STATUS_META[s].title && STATUS_META[s].blurb)
  })
})

describe('mergeScorecards', () => {
  const india = {
    params: { benchmark: '^NSEI' },
    signals: [
      { signal: 'breakout_20d', label: '20-day breakout', source: 'reconstructed', ruleVersion: 'v2', currentRules: true, firings: 300, firstFired: '2026-04-10', headline: h('negative', '-0.4% vs NIFTY over 10d (n=280)') },
      { signal: 'breakout_20d', label: '20-day breakout', source: 'reconstructed', ruleVersion: 'v1', currentRules: false, firings: 90, headline: h('positive', '+0.2%') },
      { signal: 'picks_top25', label: 'Quant picks (top 25)', source: 'recorded', currentRules: null, firings: 40, headline: h('thin', 'n=12 — too few to judge') },
      { signal: 'risk_regime', label: 'Money flow', source: 'recorded', market: 'US', headline: h('unscoreable', 'Cannot be scored yet') },
      { signal: 'rrg_rotation', label: 'RRG (India)', source: 'recorded', market: 'IN', headline: h('unscoreable', 'Cannot be scored yet') },
    ],
  }
  const rrg = {
    market: 'US', benchmark: 'SPY',
    signals: [
      { signal: 'us_rrg_enter_leading', label: 'RRG: entered Leading', source: 'reconstructed', firings: 196, weeks: 154, headline: h('thin', 'no clear edge (+0.07%, n=194)') },
      { signal: 'us_rrg_enter_leading', label: 'RRG: entered Leading', source: 'recorded', firings: 0, headline: h('no-data', 'No resolved entries yet') },
    ],
  }
  const usPicks = { params: { benchmark: 'SPY' }, signals: [{ signal: 'us_picks_top25', label: 'US quant picks (top 25)', source: 'recorded', market: 'US', firings: 500, headline: h('positive', '+0.9% vs SPY over 10d (n=400)') }] }

  test('lists current rules only, and counts the superseded versions instead of hiding them', () => {
    const rows = mergeScorecards({ india })
    const b = rows.filter(r => r.signal === 'breakout_20d')
    assert.equal(b.length, 1)
    assert.equal(b[0].ruleVersion, 'v2')
    assert.equal(b[0].olderVersions, 1)
    assert.equal(b[0].supersededRules, false)
    assert.equal(b[0].benchmark, 'NIFTY 50')
  })

  // The state the app was actually in on 2026-11-16: three versions of every
  // price signal and none of them current. The signal must not vanish.
  test('with no current-rules row, shows the newest version and says it is superseded', () => {
    const split = { params: {}, signals: [
      { signal: 'bb_squeeze', source: 'reconstructed', ruleVersion: 'legacy', currentRules: false, firings: 6881, lastFired: '2026-10-01', headline: h('negative', '-0.38%') },
      { signal: 'bb_squeeze', source: 'reconstructed', ruleVersion: 'v-a', currentRules: false, firings: 1275, lastFired: '2026-10-26', headline: h('negative', '-2.3%') },
      { signal: 'bb_squeeze', source: 'reconstructed', ruleVersion: 'v-b', currentRules: false, firings: 1233, lastFired: '2026-11-13', headline: h('negative', '-5.31%') },
    ] }
    const rows = mergeScorecards({ india: split })
    assert.equal(rows.length, 1)
    assert.deepEqual([rows[0].ruleVersion, rows[0].supersededRules, rows[0].olderVersions], ['v-b', true, 2])
    // All three stay visible, newest first, each with its own result — the
    // five-month version must be readable beside the six-week one.
    assert.deepEqual(rows[0].versions.map(v => [v.ruleVersion, v.firings, v.text, v.shown]),
      [['v-b', 1233, '-5.31%', true], ['v-a', 1275, '-2.3%', false], ['legacy', 6881, '-0.38%', false]])
  })

  // Signals with no current-version tracking (52-week highs, picks) can still
  // be split by version; they get one row too, without the superseded flag.
  test('a signal with untracked versions is one row, newest first', () => {
    const highs = { params: {}, signals: [
      { signal: 'high_52w', source: 'recorded', ruleVersion: 'legacy', currentRules: null, lastFired: '2026-10-01', headline: h('negative', '-0.35%') },
      { signal: 'high_52w', source: 'recorded', ruleVersion: 'h2', currentRules: null, lastFired: '2026-11-13', headline: h('negative', '-6.06%') },
    ] }
    const rows = mergeScorecards({ india: highs })
    assert.deepEqual([rows.length, rows[0].ruleVersion, rows[0].supersededRules, rows[0].olderVersions], [1, 'h2', false, 1])
  })

  test('keeps recorded and reconstructed evidence as separate rows', () => {
    const rows = mergeScorecards({ rrg }).filter(r => r.signal === 'us_rrg_enter_leading')
    assert.deepEqual(rows.map(r => [r.source, r.status]), [['reconstructed', 'no-edge'], ['recorded', 'thin']])
  })

  test('takes each row\'s market from its entry, defaulting to its scorecard\'s', () => {
    const rows = mergeScorecards({ india, usPicks, rrg })
    const market = (s) => rows.find(r => r.signal === s).market
    assert.equal(market('breakout_20d'), 'IN')
    assert.equal(market('risk_regime'), 'US')
    assert.equal(market('us_picks_top25'), 'US')
    assert.equal(market('us_rrg_enter_leading'), 'US')
  })

  test('works with any scorecard missing', () => {
    assert.deepEqual(mergeScorecards({}), [])
    assert.equal(mergeScorecards({ usPicks }).length, 1)
    assert.equal(mergeScorecards().length, 0)
  })

  test('summarize counts every row once, in a known state', () => {
    const rows = mergeScorecards({ india, usPicks, rrg })
    const s = summarize(rows)
    assert.equal(s.total, rows.length)
    assert.equal(Object.values(s.counts).reduce((a, b) => a + b, 0), rows.length)
    assert.deepEqual(s.counts, { measured: 2, 'no-edge': 1, thin: 2, blocked: 2 })
  })

  test('sorts India first, then by label, recorded before reconstructed', () => {
    const rows = sortRows(mergeScorecards({ india, usPicks, rrg }))
    assert.equal(rows[0].market, 'IN')
    const lead = rows.filter(r => r.signal === 'us_rrg_enter_leading').map(r => r.source)
    assert.deepEqual(lead, ['recorded', 'reconstructed'])
  })
})
