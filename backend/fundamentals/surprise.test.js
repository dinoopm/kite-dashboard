const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  matchConsensus, classifySurprise, scopeSurprise, revisionBreadth,
  INLINE_BAND, MIN_RECORDING_DAYS, MIN_SAMPLE,
} = require('./surprise');

// Phase 3's whole risk is claiming a surprise that was never a surprise: a
// consensus read AFTER the result is just the result, and a backfilled row's
// first_seen_at is bulk-load time rather than a landing date. Every fixture
// below is about refusing to pretend.

const snap = (symbol, snapDate, trendEndDate, epsAvg, extra = {}) =>
  ({ symbol, snapDate, trendEndDate, epsAvg, analysts: 12, ...extra });

const result = (symbol, periodEnd, eps, firstSeenAt, extra = {}) =>
  ({ symbol, periodEnd, eps, firstSeenAt, backfilled: false, ...extra });

describe('matchConsensus', () => {
  test('takes the latest snapshot from BEFORE the result landed', () => {
    const snaps = [
      snap('AAA', '2026-07-01', '2026-06-30', 2.0),
      snap('AAA', '2026-07-20', '2026-06-30', 2.2),   // the last word before the result
      snap('AAA', '2026-07-30', '2026-06-30', 2.9),   // AFTER — this is the result echoed back
    ];
    const m = matchConsensus(result('AAA', '2026-06-30', 3.0, '2026-07-25'), snaps);
    assert.equal(m.epsAvg, 2.2);
    assert.equal(m.snapDate, '2026-07-20');
  });

  // The whole point. A consensus dated the day of or after the announcement has
  // already absorbed it, and scoring against it would manufacture a perfect
  // forecast out of nothing.
  test('a snapshot on the landing day itself does not count as pre-announcement', () => {
    const snaps = [snap('AAA', '2026-07-25', '2026-06-30', 2.9)];
    const m = matchConsensus(result('AAA', '2026-06-30', 3.0, '2026-07-25'), snaps);
    assert.equal(m, null);
  });

  test('a backfilled result can never have one, whatever snapshots exist', () => {
    const snaps = [snap('AAA', '2026-07-20', '2026-06-30', 2.2)];
    const r = result('AAA', '2026-06-30', 3.0, '2026-07-25', { backfilled: true });
    assert.equal(matchConsensus(r, snaps), null,
      'first_seen_at on a backfilled row is when the bulk load ran, not when the company reported');
  });

  test('nor can one with no landing date recorded at all', () => {
    const snaps = [snap('AAA', '2026-07-20', '2026-06-30', 2.2)];
    assert.equal(matchConsensus(result('AAA', '2026-06-30', 3.0, null), snaps), null);
  });

  // The relative-label trap, in its consequence: '0q' meant Jun before the
  // result and Sep after it, so a match on the label would attach the wrong
  // quarter's expectation.
  test('joins on the stored end date, so a different quarter never matches', () => {
    const snaps = [
      snap('AAA', '2026-07-20', '2026-09-30', 2.6),   // next quarter's estimate
      snap('AAA', '2026-07-20', '2026-06-30', 2.2),   // this quarter's
    ];
    const m = matchConsensus(result('AAA', '2026-06-30', 3.0, '2026-07-25'), snaps);
    assert.equal(m.epsAvg, 2.2);
  });

  test('and a quarter with no matching end date is simply unmatched', () => {
    const snaps = [snap('AAA', '2026-07-20', '2026-12-31', 2.6)];
    assert.equal(matchConsensus(result('AAA', '2026-06-30', 3.0, '2026-07-25'), snaps), null);
  });

  test('another symbol\'s snapshot is not borrowed', () => {
    const snaps = [snap('BBB', '2026-07-20', '2026-06-30', 2.2)];
    assert.equal(matchConsensus(result('AAA', '2026-06-30', 3.0, '2026-07-25'), snaps), null);
  });
});

describe('classifySurprise', () => {
  // Screener reports as-reported EPS; Yahoo's consensus is normalized. The two
  // differ systematically, so a hair-thin threshold would label every single
  // result a beat or a miss and none of it would mean anything.
  test('a difference inside the band is inline, not a beat', () => {
    assert.equal(classifySurprise(2.01, 2.00).verdict, 'inline');
    assert.ok(INLINE_BAND >= 0.01, 'the band has to be wider than the reporting-basis gap');
  });

  test('a real move clears it in both directions', () => {
    assert.equal(classifySurprise(2.40, 2.00).verdict, 'beat');
    assert.equal(classifySurprise(1.60, 2.00).verdict, 'miss');
  });

  test('a near-zero consensus yields no verdict rather than a huge percentage', () => {
    const c = classifySurprise(0.10, 0.001);
    assert.equal(c.verdict, 'noConsensus');
    assert.match(c.reason, /too small|near zero/i);
  });

  test('a negative consensus is handled by magnitude, not by sign flip', () => {
    // Expected a loss of 2.00, delivered a loss of 1.00: that is a beat.
    assert.equal(classifySurprise(-1.00, -2.00).verdict, 'beat');
    assert.equal(classifySurprise(-3.00, -2.00).verdict, 'miss');
  });

  test('a missing actual or consensus is not a miss', () => {
    assert.equal(classifySurprise(null, 2.0).verdict, 'noConsensus');
    assert.equal(classifySurprise(2.0, null).verdict, 'noConsensus');
  });
});

describe('scopeSurprise', () => {
  const many = (n, verdictShift) => Array.from({ length: n }, (_, i) => ({
    symbol: `S${i}`, periodEnd: '2026-06-30', eps: 2.0 + verdictShift, firstSeenAt: '2026-07-25',
    backfilled: false,
  }));
  const snapsFor = (results) => results.map(r => snap(r.symbol, '2026-07-20', '2026-06-30', 2.0));

  test('refuses to characterise until it has been recording long enough', () => {
    const results = many(MIN_SAMPLE + 5, 0.5);
    const s = scopeSurprise({
      results, snapshots: snapsFor(results),
      recordingSince: '2026-07-01', asOf: '2026-07-26',   // 25 days of history
    });
    assert.equal(s.sufficient, false);
    assert.match(s.note, /recording began/i);
    assert.ok(s.beat > 0, 'the counts are still reported — only the characterisation is withheld');
  });

  test('and refuses on too few resolved results even with a long history', () => {
    const results = many(3, 0.5);
    const s = scopeSurprise({
      results, snapshots: snapsFor(results),
      recordingSince: '2025-01-01', asOf: '2026-07-26',
    });
    assert.equal(s.sufficient, false);
    assert.ok(MIN_SAMPLE > 3);
  });

  test('speaks once both floors clear', () => {
    const results = many(MIN_SAMPLE + 5, 0.5);
    const s = scopeSurprise({
      results, snapshots: snapsFor(results),
      recordingSince: '2025-01-01', asOf: '2026-07-26',
    });
    assert.equal(s.sufficient, true);
    assert.equal(s.beat, MIN_SAMPLE + 5);
    assert.equal(s.noConsensus, 0);
  });

  test('unmatched results are counted as noConsensus, never as inline', () => {
    const results = many(5, 0.5);
    const s = scopeSurprise({ results, snapshots: [], recordingSince: '2025-01-01', asOf: '2026-07-26' });
    assert.equal(s.noConsensus, 5);
    assert.equal(s.inline, 0, 'no data is not agreement');
  });

  test('the basis caveat travels with the numbers', () => {
    const results = many(5, 0.5);
    const s = scopeSurprise({ results, snapshots: snapsFor(results), recordingSince: '2025-01-01', asOf: '2026-07-26' });
    assert.match(s.basisNote, /normali[sz]ed|as-reported/i);
  });
});

describe('revisionBreadth', () => {
  const twoDates = (symbol, endDate, then, now) => ([
    snap(symbol, '2026-07-01', endDate, then),
    snap(symbol, '2026-07-31', endDate, now),
  ]);

  test('counts estimates raised against estimates cut', () => {
    const snaps = [
      ...twoDates('A', '2026-12-31', 2.0, 2.2),   // raised
      ...twoDates('B', '2026-12-31', 2.0, 1.8),   // cut
      ...twoDates('C', '2026-12-31', 2.0, 2.0),   // unchanged
    ];
    const r = revisionBreadth(snaps, { asOf: '2026-07-31', windowDays: 30, minSymbols: 1 });
    assert.equal(r.raised, 1);
    assert.equal(r.cut, 1);
    assert.equal(r.unchanged, 1);
    assert.equal(r.n, 3);
  });

  // The same trap as trap 11, one level up: comparing this quarter's estimate
  // against next quarter's would read as a violent revision when nothing moved.
  test('compares the SAME forecast period across the two dates', () => {
    const snaps = [
      snap('A', '2026-07-01', '2026-09-30', 2.0),
      snap('A', '2026-07-31', '2026-12-31', 3.0),   // a different quarter entirely
    ];
    const r = revisionBreadth(snaps, { asOf: '2026-07-31', windowDays: 30, minSymbols: 1 });
    assert.equal(r.n, 0, 'nothing comparable — not a 50% upgrade');
  });

  test('stays quiet until enough symbols have two readings', () => {
    const snaps = twoDates('A', '2026-12-31', 2.0, 2.2);
    const r = revisionBreadth(snaps, { asOf: '2026-07-31', windowDays: 30 });
    assert.equal(r.sufficient, false);
    assert.ok(r.n < MIN_SAMPLE);
  });

  test('a symbol with only one reading in the window contributes nothing', () => {
    const snaps = [snap('A', '2026-07-31', '2026-12-31', 2.2)];
    const r = revisionBreadth(snaps, { asOf: '2026-07-31', windowDays: 30, minSymbols: 1 });
    assert.equal(r.n, 0);
  });

  test('reports the window it used, so the number can be read', () => {
    const r = revisionBreadth([], { asOf: '2026-07-31', windowDays: 30 });
    assert.equal(r.windowDays, 30);
    assert.equal(r.n, 0);
  });
});
