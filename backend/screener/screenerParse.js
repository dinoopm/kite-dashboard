// ─── screener.in table parsing ───────────────────────────────────────────────
//
// Pulled out of server.js so it can be tested against saved HTML without
// booting the app. These parsers are the app's only source of company
// financials, and they read a third-party page that can change shape without
// notice — untested, a silent mis-parse would just render as a plausible wrong
// number, which is the worst failure mode a dashboard has.
//
// Nothing here fetches. `pickScreenerBasis` takes the fetcher as an argument so
// the basis-selection rules can be exercised with fixtures.

const cheerio = require('cheerio');

// Convert "Mar 2023" cell header to an Indian-FY label + sortable key.
function parseScreenerHeader(text) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [monthStr, yearStr] = text.trim().split(/\s+/);
  const m = months.indexOf(monthStr) + 1;
  const y = parseInt(yearStr, 10);
  if (!m || !y) return null;
  // Apr–Jun=Q1, Jul–Sep=Q2, Oct–Dec=Q3, Jan–Mar=Q4
  const q = m <= 3 ? 4 : m <= 6 ? 1 : m <= 9 ? 2 : 3;
  const fy = m >= 4 ? y + 1 : y;
  // YYYYMM sort key works because columns are in chronological order regardless.
  return {
    q, fy, month: m, year: y,
    label: `Q${q} FY${String(fy).slice(-2)}`,
    sortKey: y * 100 + m,
  };
}

// Maps screener's row label to our internal field name. Banks/NBFCs sometimes
// use "Revenue" or "Financing Profit" — we accept both.
const SCREENER_ROW_MAP = {
  'Sales': 'totalIncome',
  'Revenue': 'totalIncome',
  'Operating Profit': 'operatingProfit',
  'Financing Profit': 'operatingProfit', // NBFCs
  'OPM %': 'opm',
  'Financing Margin %': 'opm',
  'Net Profit': 'netProfit',
  'EPS in Rs': 'eps',
  'Expenses': 'expenses',
  'Other Income': 'otherIncome',
  'Interest': 'interest',
  'Depreciation': 'depreciation',
  'Profit before tax': 'pbt',
  'Tax %': 'taxPct',
};

function parseNumberCell(text) {
  if (!text) return null;
  const cleaned = text.trim().replace(/,/g, '').replace(/%/g, '').replace(/\s/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const num = parseFloat(cleaned);
  return Number.isNaN(num) ? null : num;
}

function parseScreenerQuarterly(html) {
  const $ = cheerio.load(html);
  const section = $('section#quarters');
  if (section.length === 0) throw new Error('Quarterly section not found on screener page');
  const table = section.find('table.data-table').first();
  if (table.length === 0) throw new Error('Quarterly table not found');

  // First header cell is empty (the "metric" column). Rest are month headers.
  const headerCells = table.find('thead th').toArray();
  const columns = headerCells.slice(1)
    .map(el => parseScreenerHeader($(el).text()))
    .filter(Boolean);
  if (columns.length === 0) throw new Error('No quarter columns parsed');

  // Each row's first cell is a metric label (with trailing " +" sometimes —
  // those are screener's "expand for breakdown" hints we strip).
  table.find('tbody tr').each((_, tr) => {
    const tds = $(tr).find('td').toArray();
    if (tds.length === 0) return;
    const rawLabel = $(tds[0]).text().trim().replace(/\s*\+\s*$/, '').replace(/\s+/g, ' ');
    const field = SCREENER_ROW_MAP[rawLabel];
    if (!field) return;
    tds.slice(1).forEach((td, i) => {
      if (i >= columns.length) return;
      columns[i][field] = parseNumberCell($(td).text());
    });
  });

  return columns;
}

// Same row labels as the quarterly table, but `section#profit-loss` carries one
// column per fiscal year. Screener's rightmost "TTM" column has no parseable
// month header, so parseScreenerHeader returns null for it and it's filtered
// out — the yearly view shows completed fiscal years only.
function parseScreenerAnnualPL(html) {
  const $ = cheerio.load(html);
  const section = $('section#profit-loss');
  if (section.length === 0) throw new Error('Profit & Loss section not found on screener page');
  const table = section.find('table.data-table').first();
  if (table.length === 0) throw new Error('Profit & Loss table not found');

  const headerCells = table.find('thead th').toArray();
  const columns = headerCells.slice(1).map(el => {
    const parsed = parseScreenerHeader($(el).text());
    if (!parsed) return null;
    // Annual columns are fiscal-year ends — relabel FYxx and sort by year.
    return { ...parsed, label: `FY${String(parsed.fy).slice(-2)}`, sortKey: parsed.fy };
  }).filter(Boolean);
  if (columns.length === 0) throw new Error('No P&L year columns parsed');

  table.find('tbody tr').each((_, tr) => {
    const tds = $(tr).find('td').toArray();
    if (tds.length === 0) return;
    const rawLabel = $(tds[0]).text().trim().replace(/\s*\+\s*$/, '').replace(/\s+/g, ' ');
    const field = SCREENER_ROW_MAP[rawLabel];
    if (!field) return;
    tds.slice(1).forEach((td, i) => {
      if (i >= columns.length) return;
      columns[i][field] = parseNumberCell($(td).text());
    });
  });

  return columns;
}

// ─── Consolidated-vs-standalone basis picker ─────────────────────────────────
// screener.in serves two different companies under one ticker: standalone (the
// listed entity alone) and consolidated (the group). For a holding-heavy name
// the gap is not cosmetic — Tata Power's Jun-2026 sales are ₹5,689 Cr
// standalone and ₹19,051 Cr consolidated, because the subsidiaries that ARE the
// business sit outside the standalone entity. screener.in itself defaults to
// consolidated, so a dashboard showing standalone silently disagrees with the
// page a user checks it against.
//
// Consolidated is not always usable, hence the fallbacks (the balance-sheet
// endpoint learned these the hard way): the page can 404 for companies with no
// subsidiaries, return a 200 "shell" with empty tables, or be STALE — a company
// that stopped filing consolidated leaves an old consolidated page up while
// standalone keeps running. So: try consolidated, and fall back to standalone
// whenever standalone is fresher or consolidated is unusable.
//
// @param fetchHtml  async (symbol, { consolidated }) => { html }
// @param latestOf   maps a parsed series to a recency key (YYYYMM for quarters,
//                   fiscal year for annuals)
async function pickScreenerBasis(symbol, { consolidated, parse, latestOf, fetchHtml, tag }) {
  const parseBasis = async (useConsolidated) => {
    const { html } = await fetchHtml(symbol, { consolidated: useConsolidated });
    return parse(html);
  };

  if (!consolidated) return { rows: await parseBasis(false), basis: 'standalone' };

  let consRows = null;
  try {
    consRows = await parseBasis(true);
  } catch (err) {
    console.log(`[${tag}] ${symbol} consolidated unusable (${err.message}) — falling back to standalone`);
  }

  if (consRows && consRows.length >= 2) {
    // Consolidated parsed, but check it isn't a stale leftover before trusting it.
    let stdRows = null;
    try { stdRows = await parseBasis(false); } catch { /* standalone optional here */ }
    if (stdRows && stdRows.length && latestOf(stdRows) > latestOf(consRows)) {
      console.log(`[${tag}] ${symbol} consolidated is stale — using standalone`);
      return { rows: stdRows, basis: 'standalone' };
    }
    return { rows: consRows, basis: 'consolidated' };
  }

  return { rows: await parseBasis(false), basis: 'standalone' };
}

const SCREENER_CASHFLOW_ROW_MAP = {
  'Cash from Operating Activity': 'operatingCashFlow',
  'Cash from Investing Activity': 'investingCashFlow',
  'Cash from Financing Activity': 'financingCashFlow',
  'Net Cash Flow': 'netCashFlow',
  'Free Cash Flow': 'freeCashFlow',
};

function parseScreenerCashflow(html) {
  const $ = cheerio.load(html);
  const section = $('section#cash-flow');
  if (section.length === 0) throw new Error('Cashflow section not found on screener page');
  const table = section.find('table.data-table').first();
  if (table.length === 0) throw new Error('Cashflow table not found');

  // Headers are fiscal-year ends (e.g. "Mar 2024" = FY24). Build a label per column.
  const headerCells = table.find('thead th').toArray();
  const columns = headerCells.slice(1).map(el => {
    const parsed = parseScreenerHeader($(el).text());
    if (!parsed) return null;
    // For annual cashflow, label by FY only (the Q is always FY-end Q4 = Mar).
    return { ...parsed, fyLabel: `FY${String(parsed.fy).slice(-2)}` };
  }).filter(Boolean);
  if (columns.length === 0) throw new Error('No cashflow year columns parsed');

  table.find('tbody tr').each((_, tr) => {
    const tds = $(tr).find('td').toArray();
    if (tds.length === 0) return;
    const rawLabel = $(tds[0]).text().trim().replace(/\s*\+\s*$/, '').replace(/\s+/g, ' ');
    const field = SCREENER_CASHFLOW_ROW_MAP[rawLabel];
    if (!field) return;
    tds.slice(1).forEach((td, i) => {
      if (i >= columns.length) return;
      columns[i][field] = parseNumberCell($(td).text());
    });
  });

  // Drop columns with no data. Screener emits a blank header column for the
  // current fiscal year before results are filed (e.g. SCHNEIDER's "Mar 2026"
  // ahead of FY26 reporting), which would otherwise render as an empty FY bar.
  const cfFields = Object.values(SCREENER_CASHFLOW_ROW_MAP);
  return columns.filter(c => cfFields.some(f => c[f] != null));
}

module.exports = {
  parseScreenerHeader, parseNumberCell, SCREENER_ROW_MAP,
  parseScreenerQuarterly, parseScreenerAnnualPL, parseScreenerCashflow,
  SCREENER_CASHFLOW_ROW_MAP, pickScreenerBasis,
};
