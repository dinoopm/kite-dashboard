const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { fiscalYearEndMonth, quarterLabel, belowTheLine } = require('./fiscalPeriod');

const d = (iso) => new Date(`${iso}T00:00:00Z`);

describe('fiscalYearEndMonth', () => {
  // Apple closes its year on the last Saturday of September, so the dates drift
  // by days but never out of the month.
  test('reads the month a company actually closes its year in', () => {
    assert.equal(fiscalYearEndMonth([d('2023-09-30'), d('2024-09-28'), d('2025-09-27')]), 9);
  });

  test('calls a calendar-aligned company December', () => {
    assert.equal(fiscalYearEndMonth([d('2024-12-31'), d('2025-12-31')]), 12);
  });

  // One odd row — a restated stub, a transition period — must not move the
  // whole company's fiscal calendar.
  test('takes the most common month rather than the latest', () => {
    assert.equal(fiscalYearEndMonth([d('2023-09-30'), d('2024-09-28'), d('2025-09-27'), d('2026-03-31')]), 9);
  });

  test('says nothing when there is nothing to read', () => {
    assert.equal(fiscalYearEndMonth([]), null);
    assert.equal(fiscalYearEndMonth(null), null);
  });
});

describe('quarterLabel', () => {
  // AMD's fiscal year is the calendar year, so the calendar label is already
  // the company's own label and nothing should change.
  test('leaves a calendar-year company alone', () => {
    assert.deepEqual(quarterLabel(d('2026-06-30'), 12), { label: "Q2 '26", fiscal: false });
    assert.deepEqual(quarterLabel(d('2025-12-31'), 12), { label: "Q4 '25", fiscal: false });
  });

  // Apple's September quarter is its FOURTH, and the December one opens the
  // NEXT fiscal year. Labelling them Q3 '25 and Q4 '25 gives the right numbers
  // the wrong names — the ones the company's own filings never use.
  test('names an off-calendar quarter the way the company does', () => {
    assert.deepEqual(quarterLabel(d('2025-09-27'), 9), { label: 'Q4 FY25', fiscal: true });
    assert.deepEqual(quarterLabel(d('2025-12-31'), 9), { label: 'Q1 FY26', fiscal: true });
    assert.deepEqual(quarterLabel(d('2026-03-31'), 9), { label: 'Q2 FY26', fiscal: true });
    assert.deepEqual(quarterLabel(d('2026-06-30'), 9), { label: 'Q3 FY26', fiscal: true });
  });

  test('handles a June year-end', () => {
    // Microsoft: the September quarter is its first.
    assert.deepEqual(quarterLabel(d('2025-09-30'), 6), { label: 'Q1 FY26', fiscal: true });
    assert.deepEqual(quarterLabel(d('2026-06-30'), 6), { label: 'Q4 FY26', fiscal: true });
  });

  test('falls back to the calendar when the fiscal year is unknown', () => {
    assert.deepEqual(quarterLabel(d('2026-06-30'), null), { label: "Q2 '26", fiscal: false });
  });

  // A 52/53-week calendar can close a quarter a few days either side of the
  // month boundary. The label must not jump a quarter because of it.
  test('tolerates a quarter that closes days into the next month', () => {
    assert.equal(quarterLabel(d('2025-10-01'), 9).label, 'Q4 FY25');
    assert.equal(quarterLabel(d('2025-09-27'), 9).label, 'Q4 FY25');
  });
});

describe('belowTheLine', () => {
  // AMD Q2 2025 as filed: a pretax LOSS of 74M and an 834M tax benefit make
  // 760M, but net income was 872M. The 112M difference is real — equity-method
  // income and other items below the tax line — and the table showing only
  // three of those rows cannot be made to add up. Naming the residual is the
  // honest fix; silently hiding it invites the reader to think the page is
  // broken, and "correcting" net income would be worse.
  test('reports the residual when the three shown lines do not add up', () => {
    assert.equal(belowTheLine({ pretaxIncome: -74e6, tax: -834e6, netIncome: 872e6 }), 112e6);
    assert.equal(belowTheLine({ pretaxIncome: 2.07e9, tax: 455e6, netIncome: 1.51e9 }), -105e6);
  });

  test('is null when the lines do add up', () => {
    assert.equal(belowTheLine({ pretaxIncome: 2551e6, tax: 252e6, netIncome: 2299e6 }), null);
  });

  test('ignores a rounding-sized residual', () => {
    assert.equal(belowTheLine({ pretaxIncome: 2551e6, tax: 252e6, netIncome: 2297e6 }), null);
  });

  test('is null when any of the three is missing', () => {
    assert.equal(belowTheLine({ pretaxIncome: null, tax: 252e6, netIncome: 2297e6 }), null);
    assert.equal(belowTheLine({ pretaxIncome: 2551e6, tax: null, netIncome: 2297e6 }), null);
    assert.equal(belowTheLine({ pretaxIncome: 2551e6, tax: 252e6, netIncome: null }), null);
  });
});
