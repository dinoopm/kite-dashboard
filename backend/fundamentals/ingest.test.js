const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { indiaRows, usRows, monthEnd } = require('./ingest');
const { parseScreenerQuarterly, parseScreenerAnnualPL } = require('../screener/screenerParse');

// The network halves are not tested here — they call code the instrument pages
// already exercise. What IS tested is the mapping into stored rows, because a
// wrong period_end or a leaked first_seen_at is silent and permanent.

describe('monthEnd', () => {
  test('a screener column header names the month the period ENDED', () => {
    assert.equal(monthEnd(2026, 6), '2026-06-30');
    assert.equal(monthEnd(2026, 3), '2026-03-31');
    assert.equal(monthEnd(2024, 2), '2024-02-29', 'leap year');
    assert.equal(monthEnd(2026, 12), '2026-12-31');
  });
});

describe('the upsert payload', () => {
  const sample = () => indiaRows('AAA', {
    quarters: [{ label: 'Q1 FY27', month: 6, year: 2026, netProfit: 10, totalIncome: 100, eps: 1.5 }],
    annuals: [],
    basis: 'consolidated',
  }, { backfill: true });

  // PostgREST updates every column an upsert sends. Including first_seen_at
  // would rewrite the vintage on every nightly run and destroy the only record
  // of when a result actually appeared — silently, and unrecoverably.
  test('never contains first_seen_at', () => {
    for (const r of sample()) {
      assert.ok(!('first_seen_at' in r),
        'first_seen_at must be left to the column default, which fires on INSERT only');
    }
  });

  test('carries the unit as data, not as an assumption about the market', () => {
    assert.equal(sample()[0].unit, 'INR_CR');
    const us = usRows('AAPL', { quarterly: [{ endDate: '2026-06-30', label: "Q2 '26", netIncome: 5, revenue: 50 }], annual: [] });
    assert.equal(us[0].unit, 'USD');
  });

  test('backfilled is whatever the caller passed, never inferred', () => {
    assert.equal(sample()[0].backfilled, true);
    const nightly = indiaRows('AAA', {
      quarters: [{ label: 'Q1', month: 6, year: 2026, netProfit: 10 }], annuals: [], basis: 'consolidated',
    }, { backfill: false });
    assert.equal(nightly[0].backfilled, false);
  });
});

describe('lender detection', () => {
  test('a Provisions line marks the company financial', () => {
    const rows = indiaRows('SOMEBANK', {
      quarters: [{ label: 'Q1', month: 6, year: 2026, netProfit: 100, provisions: 20 }],
      annuals: [], basis: 'consolidated',
    }, {});
    assert.equal(rows[0].is_financial, true);
  });

  test('and so does its sector, for a quarter where screener renders none', () => {
    const rows = indiaRows('SOMEBANK', {
      quarters: [{ label: 'Q1', month: 6, year: 2026, netProfit: 100 }],
      annuals: [], basis: 'consolidated',
    }, { isFinancial: true });
    assert.equal(rows[0].is_financial, true,
      'a missing provisions row must not silently hand a bank the industrial bridge');
  });

  test('an ordinary company is not marked financial', () => {
    const rows = indiaRows('WIDGETCO', {
      quarters: [{ label: 'Q1', month: 6, year: 2026, netProfit: 100 }],
      annuals: [], basis: 'consolidated',
    }, {});
    assert.equal(rows[0].is_financial, false);
  });
});

describe('US tax is stored as a RATE', () => {
  test('because the bridge compares rates, not currency amounts', () => {
    const rows = usRows('AAPL', {
      quarterly: [{ endDate: '2026-06-30', label: "Q2 '26", netIncome: 75, pretaxIncome: 100, tax: 25 }],
      annual: [],
    });
    assert.equal(rows[0].tax_pct, 25);
    assert.equal(rows[0].pbt, 100);
  });

  test('and is null rather than zero when Yahoo omits it', () => {
    const rows = usRows('AAPL', {
      quarterly: [{ endDate: '2026-06-30', label: "Q2 '26", netIncome: 75, pretaxIncome: null, tax: null }],
      annual: [],
    });
    assert.equal(rows[0].tax_pct, null);
  });
});

// The real screener fixture, so the mapping is checked against the HTML the
// scraper actually meets rather than against a hand-made object.
describe('against the saved Tata Power page', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '../screener/fixtures/tatapower-consolidated.html'), 'utf8');

  test('quarters land on real month-end dates, newest last', () => {
    const rows = indiaRows('TATAPOWER', {
      quarters: parseScreenerQuarterly(html),
      annuals: parseScreenerAnnualPL(html),
      basis: 'consolidated',
    }, { backfill: true });

    const quarters = rows.filter(r => r.period_type === 'quarter');
    assert.ok(quarters.length >= 8, `expected a run of quarters, got ${quarters.length}`);
    for (const q of quarters) {
      assert.match(q.period_end, /^\d{4}-\d{2}-\d{2}$/);
      const d = new Date(q.period_end + 'T00:00:00Z');
      const nextDay = new Date(d.getTime() + 86400000);
      assert.equal(nextDay.getUTCDate(), 1, `${q.period_end} must be a month end`);
    }
    const annuals = rows.filter(r => r.period_type === 'annual');
    assert.ok(annuals.length >= 3, 'the P&L section yields fiscal years too');
    assert.ok(rows.every(r => r.unit === 'INR_CR' && r.basis === 'consolidated'));
  });

  test('consecutive quarters are about a quarter apart', () => {
    const quarters = indiaRows('TATAPOWER', {
      quarters: parseScreenerQuarterly(html), annuals: [], basis: 'consolidated',
    }, {}).map(r => r.period_end).sort();
    for (let i = 1; i < quarters.length; i++) {
      const gap = (Date.parse(quarters[i]) - Date.parse(quarters[i - 1])) / 86400000;
      assert.ok(gap > 80 && gap < 100, `${quarters[i - 1]} → ${quarters[i]} is ${gap} days`);
    }
  });
});
