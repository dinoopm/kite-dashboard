const { test } = require('node:test');
const assert = require('node:assert/strict');
const { annotateStatement, netMarginFor } = require('./statementChecks');

// Honeywell, from its own filings. The 10-K filed 2026-02-17 restated 2023
// and 2024 without Solstice (spun off 2025-10-30); FY2022 appears only in the
// earlier 10-Ks, which still include it. Yahoo shows the newest figure for
// each year, so its FY2022 → FY2023 "growth" of −6.9% is the spin-off leaving.
const fact = (year, val, filed, accn) => ({ start: `${year}-01-01`, end: `${year}-12-31`, val, filed, accn, form: '10-K' });
const gaap = {
  RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
    fact(2022, 35466e6, '2023-02-10', 'K23'), fact(2022, 35466e6, '2024-02-16', 'K24'), fact(2022, 35466e6, '2025-02-14', 'K25'),
    fact(2023, 36662e6, '2024-02-16', 'K24'), fact(2023, 36662e6, '2025-02-14', 'K25'), fact(2023, 33009e6, '2026-02-17', 'K26'),
    fact(2024, 38498e6, '2025-02-14', 'K25'), fact(2024, 34717e6, '2026-02-17', 'K26'),
    fact(2025, 37442e6, '2026-02-17', 'K26'),
  ] } },
  // Net income includes discontinued operations, so the spin-off left it alone.
  NetIncomeLoss: { units: { USD: [
    fact(2022, 4966e6, '2023-02-10', 'K23'), fact(2022, 4966e6, '2025-02-14', 'K25'),
    fact(2023, 5658e6, '2024-02-16', 'K24'), fact(2023, 5658e6, '2026-02-17', 'K26'),
    fact(2024, 5705e6, '2025-02-14', 'K25'), fact(2024, 5705e6, '2026-02-17', 'K26'),
    fact(2025, 4729e6, '2026-02-17', 'K26'),
  ] } },
  // As filed, before the 1-for-2 reverse split of 2026-06-29.
  EarningsPerShareDiluted: { units: { 'USD/shares': [
    fact(2022, 7.27, '2025-02-14', 'K25'), fact(2023, 8.47, '2026-02-17', 'K26'),
    fact(2024, 8.71, '2026-02-17', 'K26'), fact(2025, 7.36, '2026-02-17', 'K26'),
  ] } },
  WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: [
    fact(2022, 683e6, '2025-02-14', 'K25'), fact(2023, 668e6, '2026-02-17', 'K26'),
    fact(2024, 655e6, '2026-02-17', 'K26'), fact(2025, 643e6, '2026-02-17', 'K26'),
  ] } },
};
// Yahoo's rows as the P&L route maps them: split-adjusted EPS and shares.
const yahooRows = () => [
  { label: 'FY 2022', endDate: '2022-12-31', revenue: 35466e6, netIncome: 4966e6, eps: 14.54, dilutedShares: 341.55e6 },
  { label: 'FY 2023', endDate: '2023-12-31', revenue: 33009e6, netIncome: 5658e6, eps: 16.94, dilutedShares: 334.1e6 },
  { label: 'FY 2024', endDate: '2024-12-31', revenue: 34717e6, netIncome: 5705e6, eps: 17.42, dilutedShares: 327.65e6 },
  { label: 'FY 2025', endDate: '2025-12-31', revenue: 37442e6, netIncome: 4729e6, eps: 15.98, dilutedShares: 321.4e6 },
];

test('growth into a restated year is not comparable when the year before comes only from older filings', () => {
  const rows = annotateStatement(yahooRows(), gaap, false);
  assert.deepEqual(rows[1].basisBreak, {
    fields: ['revenue', 'operatingIncome'],
    restated: 'FY 2023', restatedFiled: '2026-02-17', unrestated: 'FY 2022',
  });
});

test('years the restating filing reports together stay comparable', () => {
  const rows = annotateStatement(yahooRows(), gaap, false);
  assert.equal(rows[2].basisBreak, undefined);
  assert.equal(rows[3].basisBreak, undefined);
});

test('net income growth survives a restatement that did not change net income', () => {
  const rows = annotateStatement(yahooRows(), gaap, false);
  assert.ok(!rows[1].basisBreak.fields.includes('netIncome'));
});

test('figures shown as originally filed are comparable with each other', () => {
  const original = yahooRows().slice(0, 3);
  original[1].revenue = 36662e6;
  original[2].revenue = 38498e6;
  const rows = annotateStatement(original, gaap, false);
  assert.equal(rows[1].basisBreak, undefined);
  assert.equal(rows[2].basisBreak, undefined);
});

test('a figure no filing contains is unknown, not a break', () => {
  const rows = yahooRows();
  rows[1].revenue = 33100e6;
  assert.equal(annotateStatement(rows, gaap, false)[1].basisBreak, undefined);
});

test('a period end a few days off the filing still matches it', () => {
  // Apple-style: the filing ends on a Saturday, Yahoo normalises to month end.
  const shifted = { RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
    { start: '2023-10-01', end: '2024-09-28', val: 100e9, filed: '2024-11-01', accn: 'A' },
    { start: '2024-09-29', end: '2025-09-27', val: 110e9, filed: '2025-10-31', accn: 'B' },
    { start: '2024-09-29', end: '2025-09-27', val: 105e9, filed: '2026-10-30', accn: 'C' },
  ] } } };
  const rows = annotateStatement([
    { label: 'FY 2024', endDate: '2024-09-30', revenue: 100e9 },
    { label: 'FY 2025', endDate: '2025-09-30', revenue: 105e9 },
  ], shifted, false);
  assert.equal(rows[1].basisBreak?.restatedFiled, '2026-10-30');
});

test('EPS that disagrees with the filing after the split adjustment is flagged', () => {
  const rows = annotateStatement(yahooRows(), gaap, false);
  assert.equal(rows[3].epsCheck.filed, 7.36);
  assert.ok(Math.abs(rows[3].epsCheck.expected - 14.72) < 0.01);
  assert.ok(Math.abs(rows[3].epsCheck.factor - 2) < 0.01);
});

test('split-adjusted EPS that matches the filing is left alone', () => {
  const rows = annotateStatement(yahooRows(), gaap, false);
  for (const i of [0, 1, 2]) assert.equal(rows[i].epsCheck, undefined);
});

test('EPS is not checked without both share counts', () => {
  const rows = yahooRows().map(r => ({ ...r, dilutedShares: null }));
  assert.equal(annotateStatement(rows, gaap, false)[3].epsCheck, undefined);
});

test('no filings leaves the rows untouched', () => {
  const rows = annotateStatement(yahooRows(), null, false);
  assert.ok(rows.every(r => r.basisBreak === undefined && r.epsCheck === undefined));
});

// Revenue excludes a discontinued business while net income still includes
// its profit, so dividing one by the other overstates the margin.
test('net margin uses continuing profit when a business was discontinued', () => {
  const m = netMarginFor({ revenue: 33009e6, netIncome: 5658e6, continuingNetIncome: 4915e6, discontinued: 743e6 });
  assert.ok(Math.abs(m.netMargin - 14.890) < 0.01);
  assert.equal(m.netMarginBasis, 'continuing');
});

test('net margin is unchanged when nothing was discontinued', () => {
  const m = netMarginFor({ revenue: 100, netIncome: 25, continuingNetIncome: 25, discontinued: null });
  assert.equal(m.netMargin, 25);
  assert.equal(m.netMarginBasis, undefined);
});

test('continuing profit is derived when only the discontinued figure is known', () => {
  const m = netMarginFor({ revenue: 33009e6, netIncome: 5658e6, continuingNetIncome: null, discontinued: 743e6 });
  assert.ok(Math.abs(m.netMargin - 14.890) < 0.01);
});
