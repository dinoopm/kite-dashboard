const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  announcedAtUtc, decisionsFromMeetings, biasMatches, scoreDecisions, pendingMeetings, MIN_RESOLVED,
} = require('./fomc');

// DFEDTARU around the 2026-09-16 meeting. The target range changes the day
// AFTER the announcement, which is why the scorer cannot simply read the value
// on the meeting date and call it the decision.
const TARGET = [
  { observation_date: '2026-07-28', value: 3.75 },
  { observation_date: '2026-07-29', value: 3.75 },
  { observation_date: '2026-07-30', value: 3.75 },
  { observation_date: '2026-09-15', value: 3.75 },
  { observation_date: '2026-09-16', value: 3.75 },
  { observation_date: '2026-09-17', value: 4.00 },
  { observation_date: '2026-09-18', value: 4.00 },
];
const MEETINGS = ['2026-07-29', '2026-09-16'];

describe('announcedAtUtc', () => {
  // 14:00 Eastern. Summer is UTC-4, winter UTC-5; being an hour out only
  // matters within an hour of the announcement, and the alternative is a
  // timezone dependency for one instant a month.
  test('puts the decision at 14:00 Eastern', () => {
    assert.equal(announcedAtUtc('2026-09-16'), Date.parse('2026-09-16T18:00:00Z'));
    assert.equal(announcedAtUtc('2026-01-28'), Date.parse('2026-01-28T19:00:00Z'));
  });
});

describe('decisionsFromMeetings', () => {
  test('reads the change that follows the meeting, not the value on the day', () => {
    const d = decisionsFromMeetings(MEETINGS, TARGET);
    assert.equal(d.length, 2);
    assert.deepEqual(
      d.map(x => [x.meetingDate, x.decision, x.bps]),
      [['2026-07-29', 'hold', 0], ['2026-09-16', 'hike', 25]],
    );
  });

  test('carries the range either side so the row can be checked by hand', () => {
    const sep = decisionsFromMeetings(MEETINGS, TARGET).find(x => x.meetingDate === '2026-09-16');
    assert.equal(sep.targetUpperBefore, 3.75);
    assert.equal(sep.targetUpperAfter, 4.00);
  });

  test('a cut is a cut', () => {
    const cut = [
      { observation_date: '2026-03-17', value: 4.00 },
      { observation_date: '2026-03-18', value: 4.00 },
      { observation_date: '2026-03-19', value: 3.75 },
    ];
    assert.deepEqual(
      decisionsFromMeetings(['2026-03-18'], cut).map(x => [x.decision, x.bps]),
      [['cut', -25]],
    );
  });

  // A meeting whose following days have not been published yet is UNRESOLVED,
  // not a hold. Scoring it as a hold would invent a correct answer for every
  // meeting that has just happened.
  test('refuses to call a meeting the series does not cover yet', () => {
    const d = decisionsFromMeetings(['2026-11-04'], TARGET);
    assert.equal(d.length, 0);
  });
});

describe('biasMatches', () => {
  test('each bias maps to exactly one decision', () => {
    assert.equal(biasMatches('hike-risk', 'hike'), true);
    assert.equal(biasMatches('hold-compatible', 'hold'), true);
    assert.equal(biasMatches('cut-compatible', 'cut'), true);
    assert.equal(biasMatches('hold-compatible', 'hike'), false);
    assert.equal(biasMatches('hike-risk', 'hold'), false);
  });

  test('an unknown bias is never a hit', () => {
    assert.equal(biasMatches(null, 'hold'), false);
    assert.equal(biasMatches('unknown', 'hold'), false);
  });
});

describe('scoreDecisions', () => {
  const decisions = decisionsFromMeetings(MEETINGS, TARGET);
  const snapshots = [
    { snap_date: '2026-07-29', bias: 'hold-compatible', composite_score: -0.02, created_at: '2026-07-29T04:00:00Z' },
    { snap_date: '2026-09-15', bias: 'hold-compatible', composite_score: 0.0063, created_at: '2026-09-15T04:48:10Z' },
    { snap_date: '2026-09-16', bias: 'hold-compatible', composite_score: 0.0189, created_at: '2026-09-16T09:10:36Z' },
  ];

  test('pairs each decision with the bias recorded before the announcement', () => {
    const s = scoreDecisions(decisions, snapshots);
    const sep = s.entries.find(e => e.meetingDate === '2026-09-16');
    assert.equal(sep.biasDate, '2026-09-16', 'that day\'s snapshot was written at 09:10, hours before 18:00');
    assert.equal(sep.bias, 'hold-compatible');
    assert.equal(sep.hit, false, 'hold-compatible against a hike is a miss');
  });

  // The rule the whole table exists to enforce: a claim only counts if it was
  // written down before the outcome existed.
  test('refuses a snapshot written after the announcement', () => {
    const late = [{ snap_date: '2026-09-16', bias: 'hike-risk', composite_score: 0.4, created_at: '2026-09-16T20:00:00Z' }];
    const s = scoreDecisions(decisions.filter(d => d.meetingDate === '2026-09-16'), late);
    assert.equal(s.entries[0].bias, null);
    assert.equal(s.entries[0].hit, null);
    assert.match(s.entries[0].reason, /after the announcement/);
    assert.equal(s.resolved, 0, 'and it is not counted either way');
  });

  test('falls back to the most recent earlier snapshot when the meeting day has none', () => {
    const s = scoreDecisions(decisions, snapshots.filter(x => x.snap_date !== '2026-09-16'));
    const sep = s.entries.find(e => e.meetingDate === '2026-09-16');
    assert.equal(sep.biasDate, '2026-09-15');
    assert.equal(sep.staleByDays, 1);
  });

  test('counts hits only over decisions that had a usable bias', () => {
    const s = scoreDecisions(decisions, snapshots);
    assert.equal(s.resolved, 2);
    assert.equal(s.hits, 1, 'July hold matched, September hike did not');
    assert.equal(s.unscored, 0);
  });

  // Below the sample floor the scorecard must refuse to speak. One hit in two
  // meetings is 50%, and rendering that as a hit rate is how a dashboard talks
  // someone into trusting a coin flip.
  test('refuses to quote a rate below the sample floor', () => {
    const s = scoreDecisions(decisions, snapshots);
    assert.equal(s.tooFew, true);
    assert.equal(s.hitRate, null);
    assert.match(s.verdict, /too few to judge/i);
  });

  test('quotes a rate once enough meetings have resolved', () => {
    const many = [];
    const snaps = [];
    for (let i = 0; i < MIN_RESOLVED; i++) {
      const day = String(i + 1).padStart(2, '0');
      many.push({ meetingDate: `2026-06-${day}`, decision: 'hold', bps: 0, targetUpperBefore: 4, targetUpperAfter: 4 });
      snaps.push({ snap_date: `2026-06-${day}`, bias: i === 0 ? 'hike-risk' : 'hold-compatible', composite_score: 0, created_at: `2026-06-${day}T04:00:00Z` });
    }
    const s = scoreDecisions(many, snaps);
    assert.equal(s.resolved, MIN_RESOLVED);
    assert.equal(s.tooFew, false);
    assert.ok(Math.abs(s.hitRate - (MIN_RESOLVED - 1) / MIN_RESOLVED) < 1e-9);
  });

  test('reports the split by decision type, because holds are the easy ones', () => {
    const s = scoreDecisions(decisions, snapshots);
    assert.deepEqual(s.byDecision.hold, { n: 1, hits: 1 });
    assert.deepEqual(s.byDecision.hike, { n: 1, hits: 0 });
    assert.deepEqual(s.byDecision.cut, { n: 0, hits: 0 });
  });
});

describe('pendingMeetings', () => {
  // The 2026-09-16 case on the evening of the meeting: the Fed had announced,
  // but DFEDTARU still carried the old range because the new one takes effect
  // the following day. The meeting is awaiting data, which is a different state
  // from "nothing happened" and must not be counted as either a hit or a miss.
  const snapshots = [
    { snap_date: '2026-09-16', bias: 'hold-compatible', composite_score: 0.0189, created_at: '2026-09-16T09:10:36Z' },
  ];
  const evening = Date.parse('2026-09-16T19:30:00Z');

  test('lists an announced meeting the rate series has not caught up with', () => {
    const p = pendingMeetings(['2026-09-16', '2026-10-28'], [], snapshots, evening);
    assert.equal(p.length, 1);
    assert.equal(p[0].meetingDate, '2026-09-16');
    assert.equal(p[0].bias, 'hold-compatible', 'and it carries the claim that is waiting to be judged');
  });

  test('says nothing about a meeting that has not happened', () => {
    assert.equal(pendingMeetings(['2026-10-28'], [], snapshots, evening).length, 0);
  });

  test('says nothing before the announcement hour, on the day itself', () => {
    const morning = Date.parse('2026-09-16T12:00:00Z');
    assert.equal(pendingMeetings(['2026-09-16'], [], snapshots, morning).length, 0);
  });

  test('drops a meeting once its decision has resolved', () => {
    const resolved = [{ meetingDate: '2026-09-16', decision: 'hike', bps: 25 }];
    assert.equal(pendingMeetings(['2026-09-16'], resolved, snapshots, evening).length, 0);
  });

  test('never carries a hit or a decision, because there is no outcome yet', () => {
    const p = pendingMeetings(['2026-09-16'], [], snapshots, evening);
    assert.equal(p[0].hit, undefined);
    assert.equal(p[0].decision, undefined);
  });
});
