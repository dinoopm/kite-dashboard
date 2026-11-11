const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { waitingOn, tierShares, recordedTier, sessionsBetween, provisional, validationStatus } = require('./view');

// The 2026-11-03 morning shape: Oct 30 is the last session with every input,
// Nov 2 has VIX and the SPY/TLT closes but not the HY OAS print, which FRED
// publishes about a session late. In-process the missing spread surfaces as
// NaN, not null — severityAt subtracts undefined — so both must read as absent.
const series = [
  { date: '2026-10-26', state: 'MIXED', metrics: { vix: 18.9, creditChange21: 18, rotation: 1.2 } },
  { date: '2026-10-27', state: 'CAUTION', metrics: { vix: 19.1, creditChange21: 19, rotation: -5.8 } },
  { date: '2026-10-28', state: 'CAUTION', metrics: { vix: 19.3, creditChange21: 20, rotation: -6.0 } },
  { date: '2026-10-29', state: 'CAUTION', metrics: { vix: 19.0, creditChange21: 21, rotation: -6.2 } },
  { date: '2026-10-30', state: 'CAUTION', metrics: { vix: 19.42, creditChange21: 20, rotation: -6.4 } },
  { date: '2026-11-02', state: 'INCOMPLETE', metrics: { vix: 21.15, creditChange21: NaN, rotation: -6.1 } },
];
const severity = { state: 'CAUTION', asOf: '2026-10-30', stale: false,
  metrics: { vix: 19.42, rotation: -6.4, drawdown: -3, rapidDrawdown: -2.15, creditChange21: 20, creditChange4: 14 },
  timeline: { source: 'reconstructed', series } };

describe('waitingOn', () => {
  test('names the input holding the assessment back, and how far', () => {
    assert.deepEqual(waitingOn(severity), { date: '2026-11-02', sessionsBehind: 1, missing: ['HY OAS'] });
  });

  test('says nothing when the assessment is already on the latest session', () => {
    assert.equal(waitingOn({ ...severity, timeline: { series: series.slice(0, 5) } }), null);
  });

  test('treats a null input the same as NaN', () => {
    const s = { ...severity, timeline: { series: [...series.slice(0, 5), { date: '2026-11-02', state: 'INCOMPLETE', metrics: { vix: null, creditChange21: NaN, rotation: 1 } }] } };
    assert.deepEqual(waitingOn(s).missing, ['VIX close', 'HY OAS']);
  });
});

describe('tierShares', () => {
  // How often the rule matches no tier at all. 60% of the real reconstructed
  // history was MIXED; a reader seeing CAUTION should know that MIXED, not
  // NEUTRAL, is the usual reading.
  test('reports each tier as a share of classified sessions, excluding INCOMPLETE', () => {
    const s = tierShares(severity.timeline);
    assert.equal(s.total, 5);
    assert.equal(s.counts.CAUTION, 4);
    assert.equal(s.counts.MIXED, 1);
    assert.equal(s.shares.CAUTION, 80);
    assert.equal(s.counts.INCOMPLETE, undefined);
    assert.equal(s.source, 'reconstructed', 'and says where the counts come from');
  });

  test('is null with no classified sessions', () => {
    assert.equal(tierShares({ series: [{ date: '2026-11-02', state: 'INCOMPLETE' }] }), null);
    assert.equal(tierShares(null), null);
  });
});

describe('recordedTier', () => {
  const rows = [
    { signal: 'us_risk_severity@us-risk-severity-v1', snap_date: '2026-10-27', meta: { tier: 'CAUTION', priorTier: null, asOf: '2026-10-23' } },
    { signal: 'us_risk_severity@us-risk-severity-v2', snap_date: '2026-10-27', meta: { tier: 'CAUTION', priorTier: null, asOf: '2026-10-23' } },
    { signal: 'us_risk_severity@us-risk-severity-v3', snap_date: '2026-10-27', meta: { tier: 'CAUTION', priorTier: null, asOf: '2026-10-23', capturedAt: '2026-10-27T09:00:00Z' } },
  ];

  // The chip used to read "7 sessions in this tier" off the RECONSTRUCTED
  // timeline, next to a live verdict. The recorded log is the honest source:
  // here it holds one entry, and an entry with no prior tier is where the log
  // STARTED, not where the tier did — so the tenure is a lower bound.
  test('reads the current tier from the recorded log for the current rule only', () => {
    const r = recordedTier(rows, 'us-risk-severity-v3');
    assert.equal(r.tier, 'CAUTION');
    assert.equal(r.since, '2026-10-23');
    assert.equal(r.initial, true, 'no prior tier: the log began here');
    assert.equal(r.entries, 1);
    assert.equal(r.transitions, 0);
    assert.equal(r.earlierVersions, 2, 'entries under older rule versions do not carry over');
  });

  test('counts real transitions', () => {
    const r = recordedTier([...rows, { signal: 'us_risk_severity@us-risk-severity-v3', snap_date: '2026-11-05', meta: { tier: 'MIXED', priorTier: 'CAUTION', asOf: '2026-11-04' } }], 'us-risk-severity-v3');
    assert.equal(r.tier, 'MIXED');
    assert.equal(r.initial, false);
    assert.equal(r.transitions, 1);
    assert.equal(r.entries, 2);
  });

  test('reports an empty record rather than borrowing an older version', () => {
    const r = recordedTier(rows, 'us-risk-severity-v4');
    assert.equal(r.tier, null);
    assert.equal(r.entries, 0);
    assert.equal(r.earlierVersions, 3);
  });
});

describe('sessionsBetween', () => {
  test('counts sessions inclusively on both ends', () => {
    assert.equal(sessionsBetween(series, '2026-10-27', '2026-10-30'), 4);
    assert.equal(sessionsBetween(series, '2026-10-30', '2026-10-30'), 1);
  });
});

describe('provisional', () => {
  // Same inputs, only the VIX swapped for the live quote. On 2026-11-03 the
  // Oct 30 assessment read CAUTION on VIX 19.42 while the quote stood at 21.01,
  // and CAUTION requires VIX < 20 — so the verdict on screen was already one
  // the live market had left. Never recorded: the other inputs are older.
  const fake = (metrics) => ({
    state: metrics.vix < 20 ? 'CAUTION' : 'MIXED',
    flags: [{ id: 'creditWithoutEquity', triggered: metrics.vix < 20 }, { id: 'cccLeadership', triggered: true }],
  });

  test('reports the tier and flags the live quote would produce', () => {
    const p = provisional(severity, 21.01, fake);
    assert.equal(p.vix, 21.01);
    assert.equal(p.state, 'MIXED');
    assert.equal(p.changesTier, true);
    assert.deepEqual(p.flagsOff, ['creditWithoutEquity']);
    assert.deepEqual(p.flagsOn, []);
    assert.equal(p.basis, '2026-10-30', 'and says the other inputs are still from the assessment date');
  });

  test('says the tier holds when it does', () => {
    const p = provisional(severity, 19.8, fake);
    assert.equal(p.changesTier, false);
    assert.deepEqual(p.flagsOff, []);
  });

  test('refuses a quote that is not a number', () => {
    assert.equal(provisional(severity, NaN, fake), null);
    assert.equal(provisional(severity, -1, fake), null);
  });
});

describe('validationStatus', () => {
  test('says why the badge reads Unvalidated when the study is blocked on credit vintages', () => {
    const s = validationStatus({ ruleVersion: 'v3', status: 'blocked', generatedAt: '2026-10-27T10:28:28Z', diagnostic: { vintageAvailable: false } }, 'v3');
    assert.equal(s.status, 'blocked');
    assert.match(s.reason, /historical HY OAS/i);
    assert.equal(s.lastRun, '2026-10-27');
  });

  test('flags a study that ran against an earlier rule version', () => {
    assert.equal(validationStatus({ ruleVersion: 'v1', status: 'passed' }, 'v3').status, 'other-version');
  });

  test('says when no study has run', () => {
    assert.equal(validationStatus(null, 'v3').status, 'missing');
  });
});
