const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { symbolsInReportingWindow, snapshotRows, nextQuarterEnd, WINDOW } = require('./consensus');

describe('nextQuarterEnd', () => {
  test('steps one calendar quarter forward, landing on a month end', () => {
    assert.equal(nextQuarterEnd('2026-06-30'), '2026-09-30');
    assert.equal(nextQuarterEnd('2026-12-31'), '2027-03-31');
    assert.equal(nextQuarterEnd('2025-09-30'), '2025-12-31');
  });
});

describe('symbolsInReportingWindow', () => {
  // The band, not proximity. Results land WEEKS after a quarter closes — a
  // June quarter reports in late July or August — so a tight window around the
  // period end would refresh nobody, ever.
  test('a symbol whose next quarter closed 45 days ago is in the window', () => {
    const inWindow = symbolsInReportingWindow({ AAA: '2026-03-31' }, 'IN', '2026-08-14');
    assert.deepEqual(inWindow, ['AAA']);
  });

  test('one whose quarter closed yesterday is not — nothing reports that fast', () => {
    assert.deepEqual(symbolsInReportingWindow({ AAA: '2026-03-31' }, 'IN', '2026-07-01'), []);
  });

  test('and one long past its window is not refreshed either', () => {
    assert.deepEqual(symbolsInReportingWindow({ AAA: '2026-03-31' }, 'IN', '2026-11-01'), []);
  });

  test('a symbol with nothing stored is always looked at', () => {
    assert.deepEqual(symbolsInReportingWindow({ NEW: null }, 'IN', '2026-08-14'), ['NEW']);
  });

  test('the US band is tighter than India\'s, because filers are quicker', () => {
    assert.ok(WINDOW.US.maxDays < WINDOW.IN.maxDays);
    // 70 days after the quarter end: still inside India's band, outside the US one.
    assert.deepEqual(symbolsInReportingWindow({ AAA: '2026-03-31' }, 'IN', '2026-09-08'), ['AAA']);
    assert.deepEqual(symbolsInReportingWindow({ AAA: '2026-03-31' }, 'US', '2026-09-08'), []);
  });
});

describe('snapshotRows', () => {
  const quote = {
    price: { marketCap: 1.5e12, currency: 'USD' },
    earningsTrend: {
      trend: [
        { period: '0q', endDate: '2026-09-30', earningsEstimate: { avg: 2.1, low: 1.9, high: 2.4, numberOfAnalysts: 30 }, revenueEstimate: { avg: 9e10 } },
        { period: '+1q', endDate: '2026-12-31', earningsEstimate: { avg: 2.5, numberOfAnalysts: 28 } },
      ],
    },
  };

  // The relative label is the trap: '0q' means one quarter today and a
  // different one after the result lands, so a snapshot resolved by label alone
  // would attach the wrong quarter's expectation to a result.
  test('stores the resolved end date beside the relative label', () => {
    const rows = snapshotRows('US', 'AAPL', quote, '2026-08-20');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].trend_period, '0q');
    assert.equal(rows[0].trend_end_date, '2026-09-30');
    assert.equal(rows[1].trend_end_date, '2026-12-31');
  });

  test('carries the cap and its unit from the same call', () => {
    const rows = snapshotRows('US', 'AAPL', quote, '2026-08-20');
    assert.equal(rows[0].market_cap, 1.5e12);
    assert.equal(rows[0].market_cap_unit, 'USD');
  });

  test('a symbol Yahoo has no coverage for yields no rows, not empty estimates', () => {
    assert.equal(snapshotRows('IN', 'SMALLCAP', { price: {} }, '2026-08-20').length, 0);
  });

  test('a missing estimate stays null rather than becoming zero', () => {
    const rows = snapshotRows('IN', 'AAA', {
      price: { marketCap: null, currency: 'INR' },
      earningsTrend: { trend: [{ period: '0q', endDate: '2026-09-30', earningsEstimate: {} }] },
    }, '2026-08-20');
    assert.equal(rows[0].eps_avg, null);
    assert.equal(rows[0].analysts, null);
    assert.equal(rows[0].market_cap, null);
  });
});
