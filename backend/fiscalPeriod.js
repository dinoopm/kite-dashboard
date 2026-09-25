// ─── Fiscal periods, and the lines a three-row statement cannot show ────────
//
// Two small pieces of honesty for the income-statement tabs.
//
// 1. A quarter's NAME. The label used to be the calendar quarter of the period
//    end, which is right for AMD (calendar fiscal year) and wrong for everyone
//    else: Apple's quarter ending 2025-09-27 rendered as "Q3 '25" when Apple,
//    its filings and every analyst call it Q4 FY2025. The figures were correct
//    the whole time; only the name was one the company never uses, which is the
//    kind of error a reader carries away rather than notices.
//
// 2. A quarter's ARITHMETIC. Pretax minus tax does not equal net income for
//    many companies, because equity-method income, discontinued operations and
//    minority interests sit between them. AMD's June 2025 quarter: a 74M pretax
//    loss and an 834M tax benefit make 760M against 872M of net income. Both
//    numbers are as filed. The table shows three of those rows and cannot be
//    made to add up, so the residual is computed and named rather than left for
//    a reader to find and mistrust.

const MONTHS_PER_QUARTER = 3;

// Below this a residual is rounding in the source, not a real line item.
const RESIDUAL_FLOOR = 3_000_000;

const monthOf = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.getUTCMonth() + 1 : null);

/**
 * The month a company closes its fiscal year in, read from its own annual
 * statement dates.
 *
 * The MODE, not the latest: a 52/53-week calendar drifts by days, and a single
 * odd row — a restated stub or a transition period — must not redefine the
 * company's year.
 */
function fiscalYearEndMonth(annualEndDates) {
  const counts = new Map();
  for (const d of annualEndDates || []) {
    const m = monthOf(d instanceof Date ? d : new Date(d));
    if (m) counts.set(m, (counts.get(m) || 0) + 1);
  }
  if (!counts.size) return null;
  let best = null, bestN = 0;
  for (const [m, n] of counts) if (n > bestN) { best = m; bestN = n; }
  return best;
}

/**
 * What the company calls this quarter.
 *
 * Returns `fiscal: false` for a December year-end, where the calendar label IS
 * the company's label and switching to "Q2 FY26" would add noise without adding
 * information.
 *
 * A 52/53-week year can close a quarter a few days into the next month, so the
 * period end is nudged back to the month it belongs to before the arithmetic:
 * a September year-end closing on 2025-10-01 is still the fourth quarter.
 */
function quarterLabel(endDate, fyEndMonth) {
  const d = endDate instanceof Date ? endDate : new Date(endDate);
  const year = d.getUTCFullYear();
  const calendar = {
    label: `Q${Math.floor(d.getUTCMonth() / 3) + 1} '${String(year).slice(2)}`,
    fiscal: false,
  };
  if (!fyEndMonth || fyEndMonth === 12) return calendar;

  // Days 1-3 of a month belong to the month before for this purpose.
  const nudged = new Date(d.getTime());
  if (d.getUTCDate() <= 3) nudged.setUTCDate(0);

  const m = nudged.getUTCMonth() + 1;
  const monthsSinceYearEnd = ((m - fyEndMonth) + 12) % 12;
  const q = monthsSinceYearEnd === 0 ? 4 : Math.ceil(monthsSinceYearEnd / MONTHS_PER_QUARTER);
  // Past the year-end month, the quarter belongs to the fiscal year NAMED for
  // the calendar year it will end in.
  const fy = monthsSinceYearEnd === 0
    ? nudged.getUTCFullYear()
    : (m > fyEndMonth ? nudged.getUTCFullYear() + 1 : nudged.getUTCFullYear());

  return { label: `Q${q} FY${String(fy).slice(2)}`, fiscal: true };
}

/**
 * What sits between pretax income and net income, when the two shown lines
 * cannot produce the third.
 *
 * Returns null when they reconcile, or when any of the three is missing — an
 * absent line is not evidence of a residual.
 */
function belowTheLine({ pretaxIncome, tax, netIncome } = {}) {
  if (![pretaxIncome, tax, netIncome].every(v => typeof v === 'number' && Number.isFinite(v))) return null;
  const residual = netIncome - (pretaxIncome - tax);
  return Math.abs(residual) >= RESIDUAL_FLOOR ? residual : null;
}

module.exports = { fiscalYearEndMonth, quarterLabel, belowTheLine, RESIDUAL_FLOOR };
