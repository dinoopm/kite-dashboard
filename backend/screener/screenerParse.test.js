const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseScreenerHeader, parseNumberCell,
  parseScreenerQuarterly, parseScreenerAnnualPL, parseScreenerCashflow,
  pickScreenerBasis,
} = require('./screenerParse');

// Real screener.in HTML for TATAPOWER, captured 2026-07-28 and trimmed to the
// two sections we parse. Tata Power is the right specimen: it is holding-heavy,
// so standalone and consolidated differ by roughly 3x, which is exactly the
// confusion these tests exist to prevent.
const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const STANDALONE = fixture('tatapower-standalone.html');
const CONSOLIDATED = fixture('tatapower-consolidated.html');

const byLabel = (cols) => Object.fromEntries(cols.map(c => [c.label, c]));

describe('parseScreenerHeader', () => {
  test('maps calendar month-ends to Indian fiscal quarters', () => {
    assert.deepEqual(
      ['Jun 2026', 'Sep 2025', 'Dec 2025', 'Mar 2026'].map(h => parseScreenerHeader(h).label),
      ['Q1 FY27', 'Q2 FY26', 'Q3 FY26', 'Q4 FY26'],
    );
  });

  test('rolls the fiscal year over in April, not January', () => {
    assert.equal(parseScreenerHeader('Mar 2026').fy, 2026, 'March still belongs to FY26');
    assert.equal(parseScreenerHeader('Apr 2026').fy, 2027, 'April starts FY27');
  });

  test('sorts chronologically by YYYYMM', () => {
    assert.ok(parseScreenerHeader('Jun 2026').sortKey > parseScreenerHeader('Mar 2026').sortKey);
  });

  // Screener's rightmost annual column is "TTM" — unparseable on purpose, so it
  // gets filtered out rather than rendered as a phantom fiscal year.
  test('returns null for a non-date header', () => {
    assert.equal(parseScreenerHeader('TTM'), null);
    assert.equal(parseScreenerHeader(''), null);
  });
});

describe('parseNumberCell', () => {
  test('strips thousands separators and percent signs', () => {
    assert.equal(parseNumberCell('19,051'), 19051);
    assert.equal(parseNumberCell('20%'), 20);
  });

  test('keeps negatives, which is the whole point for loss quarters', () => {
    assert.equal(parseNumberCell('-160'), -160);
    assert.equal(parseNumberCell('-0.50'), -0.5);
  });

  test('treats blanks and lone dashes as missing, not zero', () => {
    assert.equal(parseNumberCell(''), null);
    assert.equal(parseNumberCell(' - '), null);
    assert.equal(parseNumberCell(null), null);
  });
});

describe('parseScreenerQuarterly', () => {
  test('reads the standalone numbers the app used to show', () => {
    const q = byLabel(parseScreenerQuarterly(STANDALONE));
    assert.equal(q['Q1 FY27'].totalIncome, 5689);
    assert.equal(q['Q1 FY27'].netProfit, 277);
    assert.equal(q['Q1 FY27'].eps, 0.87);
    assert.equal(q['Q2 FY26'].totalIncome, 2625);
  });

  // The bug this suite exists for: same ticker, same quarter, 3.3x the sales.
  test('reads consolidated as a genuinely different set of books', () => {
    const q = byLabel(parseScreenerQuarterly(CONSOLIDATED));
    assert.equal(q['Q1 FY27'].totalIncome, 19051);
    assert.equal(q['Q1 FY27'].netProfit, 1401);
    assert.equal(q['Q1 FY27'].eps, 3.68);
  });

  test('carries a loss quarter through as a negative, not a gap', () => {
    const q = byLabel(parseScreenerQuarterly(STANDALONE));
    assert.equal(q['Q3 FY26'].netProfit, -160);
    assert.equal(q['Q3 FY26'].eps, -0.5);
  });

  test('maps every row the P&L table renders', () => {
    const q = byLabel(parseScreenerQuarterly(CONSOLIDATED))['Q1 FY27'];
    for (const f of ['totalIncome', 'expenses', 'operatingProfit', 'opm', 'netProfit', 'eps', 'interest']) {
      assert.ok(q[f] != null, `${f} should be parsed`);
    }
  });

  // Column-to-value alignment is positional, so a shifted header would put
  // Q4's revenue under Q1 and still look like a plausible table.
  test('keeps values aligned to their own quarter', () => {
    const cols = parseScreenerQuarterly(STANDALONE);
    const q = byLabel(cols);
    assert.equal(q['Q2 FY26'].totalIncome, 2625);
    assert.equal(q['Q3 FY26'].totalIncome, 2483);
    assert.equal(q['Q4 FY26'].totalIncome, 2833);
    // ...and the columns come back in chronological order.
    const keys = cols.map(c => c.sortKey);
    assert.deepEqual(keys, [...keys].sort((a, b) => a - b));
  });

  test('throws rather than returning empty when the page shape changes', () => {
    assert.throws(() => parseScreenerQuarterly('<html><body>no tables</body></html>'), /Quarterly section not found/);
  });
});

describe('parseScreenerAnnualPL', () => {
  test('labels columns by fiscal year and drops the TTM column', () => {
    const years = parseScreenerAnnualPL(CONSOLIDATED);
    assert.ok(years.length >= 5);
    for (const y of years) assert.match(y.label, /^FY\d{2}$/);
    assert.equal(years.some(y => y.label === 'FYaN' || Number.isNaN(y.fy)), false);
  });

  test('sorts by fiscal year, so the latest is last', () => {
    const years = parseScreenerAnnualPL(CONSOLIDATED);
    const keys = years.map(y => y.sortKey);
    assert.deepEqual(keys, [...keys].sort((a, b) => a - b));
  });
});

describe('parseScreenerCashflow', () => {
  const byFy = (rows) => Object.fromEntries(rows.map(r => [r.fyLabel, r]));

  test('reads the three cash-flow statements and the net', () => {
    const y = byFy(parseScreenerCashflow(CONSOLIDATED))['FY26'];
    assert.equal(y.operatingCashFlow, 5993);
    assert.equal(y.investingCashFlow, -14129);
    assert.equal(y.financingCashFlow, 7783);
    assert.equal(y.netCashFlow, -353);
  });

  // The finding that prompted the basis switch: on a standalone basis the same
  // year looks like a cash crisis, and the page raised a warning banner for it.
  test('standalone and consolidated disagree on the sign of FY26 operating cash', () => {
    const std = byFy(parseScreenerCashflow(STANDALONE))['FY26'];
    const con = byFy(parseScreenerCashflow(CONSOLIDATED))['FY26'];
    assert.ok(std.operatingCashFlow < 0, 'parent alone burned cash');
    assert.ok(con.operatingCashFlow > 0, 'the group generated it');
  });

  test('labels years by fiscal year, latest last', () => {
    const rows = parseScreenerCashflow(CONSOLIDATED);
    assert.equal(rows[rows.length - 1].fyLabel, 'FY26');
    const fys = rows.map(r => r.fy);
    assert.deepEqual(fys, [...fys].sort((a, b) => a - b));
  });

  test('throws when the section is absent', () => {
    assert.throws(() => parseScreenerCashflow('<html><body></body></html>'), /Cashflow section not found/);
  });
});

describe('pickScreenerBasis', () => {
  // Fake pages, so the selection rules are tested rather than screener.in.
  const html = (id, headers, sales) => `<html><section id="${id}"><table class="data-table">
    <thead><tr><th></th>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody><tr><td>Sales</td>${sales.map(s => `<td>${s}</td>`).join('')}</tr></tbody>
  </table></section></html>`;
  const quarters = (headers, sales) => html('quarters', headers, sales);
  const latestOf = (qs) => Math.max(...qs.map(q => q.sortKey));

  const fetcherFor = (pages) => async (symbol, { consolidated }) => {
    const page = pages[consolidated ? 'consolidated' : 'standalone'];
    if (!page) { const e = new Error('404'); e.status = 404; throw e; }
    return { html: page };
  };

  const run = (pages, consolidated = true) => pickScreenerBasis('TEST', {
    consolidated,
    parse: parseScreenerQuarterly,
    latestOf,
    fetchHtml: fetcherFor(pages),
    tag: 'test',
  });

  test('prefers consolidated when both are available and current', async () => {
    const r = await run({
      consolidated: quarters(['Mar 2026', 'Jun 2026'], ['14,900', '19,051']),
      standalone: quarters(['Mar 2026', 'Jun 2026'], ['2,833', '5,689']),
    });
    assert.equal(r.basis, 'consolidated');
    assert.equal(byLabel(r.rows)['Q1 FY27'].totalIncome, 19051);
  });

  test('falls back to standalone when the consolidated page is missing', async () => {
    const r = await run({ standalone: quarters(['Mar 2026', 'Jun 2026'], ['2,833', '5,689']) });
    assert.equal(r.basis, 'standalone');
    assert.equal(byLabel(r.rows)['Q1 FY27'].totalIncome, 5689);
  });

  test('falls back when consolidated is a 200 shell with no table', async () => {
    const r = await run({
      consolidated: '<html><body>shell, no sections</body></html>',
      standalone: quarters(['Mar 2026', 'Jun 2026'], ['2,833', '5,689']),
    });
    assert.equal(r.basis, 'standalone');
  });

  // A company that stopped filing consolidated leaves the old page up. Serving
  // it would quietly show financials that are years out of date.
  test('rejects a stale consolidated page in favour of a fresher standalone', async () => {
    const r = await run({
      consolidated: quarters(['Mar 2015', 'Jun 2015'], ['100', '110']),
      standalone: quarters(['Mar 2026', 'Jun 2026'], ['2,833', '5,689']),
    });
    assert.equal(r.basis, 'standalone');
    assert.equal(byLabel(r.rows)['Q1 FY27'].totalIncome, 5689);
  });

  test('keeps consolidated when standalone is no fresher', async () => {
    const r = await run({
      consolidated: quarters(['Mar 2026', 'Jun 2026'], ['14,900', '19,051']),
      standalone: quarters(['Mar 2025', 'Jun 2025'], ['2,000', '2,100']),
    });
    assert.equal(r.basis, 'consolidated');
  });

  test('honours an explicit request for standalone', async () => {
    const r = await run({
      consolidated: quarters(['Mar 2026', 'Jun 2026'], ['14,900', '19,051']),
      standalone: quarters(['Mar 2026', 'Jun 2026'], ['2,833', '5,689']),
    }, false);
    assert.equal(r.basis, 'standalone');
    assert.equal(byLabel(r.rows)['Q1 FY27'].totalIncome, 5689);
  });

  test('does not silently treat a one-column consolidated page as usable', async () => {
    const r = await run({
      consolidated: quarters(['Jun 2026'], ['19,051']),
      standalone: quarters(['Mar 2026', 'Jun 2026'], ['2,833', '5,689']),
    });
    assert.equal(r.basis, 'standalone');
  });
});
