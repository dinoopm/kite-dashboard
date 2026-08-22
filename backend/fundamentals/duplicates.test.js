const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { findSuspectedDuplicates, issuerGroups, MATCH_TOLERANCE } = require('./duplicates');

const r = (symbol, period_end, net_profit, revenue) => ({
  market: 'US', symbol, period_type: 'quarter', period_end, net_profit, revenue,
});

describe('findSuspectedDuplicates', () => {
  test('flags two symbols reporting the same figures across several quarters', () => {
    const rows = [];
    for (const d of ['2026-03-31', '2026-06-30', '2025-12-31']) {
      rows.push(r('GOOG', d, 100, 800), r('GOOGL', d, 100, 800), r('MSFT', d, 90, 700));
    }
    const hits = findSuspectedDuplicates(rows);
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0].symbols, ['GOOG', 'GOOGL']);
    assert.equal(hits[0].periods, 3);
  });

  test('one matching quarter is a coincidence, not a share class', () => {
    const rows = [
      r('AAA', '2026-06-30', 100, 800), r('BBB', '2026-06-30', 100, 800),
      r('AAA', '2026-03-31', 90, 700),  r('BBB', '2026-03-31', 50, 400),
    ];
    assert.equal(findSuspectedDuplicates(rows).length, 0);
  });

  // Exact equality would miss this, which is the point of the tolerance: a
  // restatement or a one-day skew between two fetches moves one class only.
  test('survives a small skew between the two classes', () => {
    const rows = [];
    for (const d of ['2026-03-31', '2026-06-30']) {
      rows.push(r('FOXA', d, 100, 800), r('FOX', d, 100.05, 800.4));
    }
    assert.equal(findSuspectedDuplicates(rows).length, 1);
  });

  test('but not a genuinely different number', () => {
    const rows = [];
    for (const d of ['2026-03-31', '2026-06-30']) {
      rows.push(r('AAA', d, 100, 800), r('BBB', d, 103, 800));
    }
    assert.equal(findSuspectedDuplicates(rows).length, 0);
    assert.ok(MATCH_TOLERANCE < 0.01, 'the net must stay tight enough to mean something');
  });

  test('matching revenue alone is not enough — same size is not same company', () => {
    const rows = [];
    for (const d of ['2026-03-31', '2026-06-30']) {
      rows.push(r('AAA', d, 100, 800), r('BBB', d, 40, 800));
    }
    assert.equal(findSuspectedDuplicates(rows).length, 0);
  });
});

describe('issuerGroups', () => {
  test('the curated list stands even with no data at all', () => {
    const groups = issuerGroups([]);
    assert.ok(groups.some(g => g.includes('GOOG') && g.includes('GOOGL')));
  });

  test('a newly detected pair is added, and a known one is not duplicated', () => {
    const rows = [];
    for (const d of ['2026-03-31', '2026-06-30']) {
      rows.push(r('GOOG', d, 100, 800), r('GOOGL', d, 100, 800));   // already curated
      rows.push(r('NEWA', d, 55, 300), r('NEWB', d, 55, 300));      // new
    }
    const groups = issuerGroups(rows);
    assert.equal(groups.filter(g => g.includes('GOOG')).length, 1);
    assert.ok(groups.some(g => g.includes('NEWA') && g.includes('NEWB')));
  });
});
