// ─── Checking Yahoo's income statement against the company's own filings ────
//
// Yahoo shows the NEWEST figure it has for each year. When a company restates
// — a spin-off moved to discontinued operations, a reclassification — the
// years its latest 10-K covers are restated and the older ones are not, so
// adjacent columns can sit on different bases. Honeywell is the case: its 10-K
// of 2026-02-17 restated 2023 and 2024 without Solstice (spun off 2025-10-30),
// FY2022 survives only in earlier 10-Ks that still include it, and the table
// printed FY2023 revenue growth of −6.9% where the company had reported +3.4%.
// Every figure was correct; the growth between them was not.
//
// Two columns are judged comparable unless exactly one of them shows a
// restated figure AND the filing that restated it does not also report the
// other column's figure as shown. Two restated columns are not compared with
// each other: a company that restates quarter by quarter would otherwise be
// flagged on every column. That can miss a second restatement, which is the
// direction to err in — this marks breaks the filings prove, nothing more.
//
// EPS is checked separately. Yahoo adjusts history for splits and the filings
// do not, so the filed EPS is scaled by the ratio of the two share counts
// before comparing. Honeywell's 1-for-2 reverse split of 2026-06-29 doubled
// every year correctly except FY2025, which Yahoo has at $15.98 against a
// filing that implies $14.72.
//
// Nothing here replaces a figure: the table keeps showing what Yahoo has and
// these marks say where it disagrees with, or cannot be compared through, the
// filings.

const PERIOD_SLACK_MS = 5 * 86400000; // Apple's years end on a Saturday
const SAME_VALUE = 0.001;             // 0.1%: vendor rounding, not a difference
const EPS_TOLERANCE = 0.02;           // 2% after scaling, and at least a cent or two

// Which growth figures each detector speaks for. A restatement that moves a
// business to discontinued operations changes revenue and everything above
// net income, but not net income itself, which includes the discontinued part.
const DETECTORS = [
  { tags: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues',
    'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet'],
    field: 'revenue', gates: ['revenue', 'operatingIncome'] },
  { tags: ['NetIncomeLoss', 'ProfitLoss'], field: 'netIncome', gates: ['netIncome'] },
];
const EPS_TAGS = ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'];
const SHARE_TAGS = ['WeightedAverageNumberOfDilutedSharesOutstanding'];

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const same = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= Math.abs(b) * SAME_VALUE;

function spans(f, isQuarter) {
  if (!f.start || !f.end) return false;
  const days = (Date.parse(f.end) - Date.parse(f.start)) / 86400000;
  return isQuarter ? days > 80 && days < 100 : days > 350 && days < 380;
}

/** Every filed value for the period ending near `end`, oldest filing first. */
function periodFacts(gaap, tags, end, isQuarter) {
  const at = Date.parse(end);
  for (const tag of tags) {
    const facts = Object.values(gaap?.[tag]?.units || {}).flat()
      .filter(f => spans(f, isQuarter) && Math.abs(Date.parse(f.end) - at) <= PERIOD_SLACK_MS && finite(f.val));
    if (facts.length) return facts.sort((a, b) => String(a.filed).localeCompare(String(b.filed)));
  }
  return [];
}

/**
 * Whether the figure shown for a period is as first filed or restated, and if
 * restated, which filing restated it. Null when no filing carries the figure.
 */
function provenance(gaap, tags, row, field, isQuarter) {
  const facts = periodFacts(gaap, tags, row.endDate, isQuarter);
  const shown = row[field];
  const matching = facts.filter(f => same(f.val, shown));
  if (!matching.length) return null;
  if (same(facts[0].val, shown)) return { restated: false, facts };
  return { restated: true, by: matching[0], facts };
}

function basisBreak(gaap, detector, prev, cur, isQuarter) {
  if (!prev.endDate || !cur.endDate) return null;
  const a = provenance(gaap, detector.tags, prev, detector.field, isQuarter);
  const b = provenance(gaap, detector.tags, cur, detector.field, isQuarter);
  if (!a || !b || a.restated === b.restated) return null;
  const [restatedRow, restated, otherRow, other] = b.restated ? [cur, b, prev, a] : [prev, a, cur, b];
  const reportedTogether = other.facts.some(f => f.accn === restated.by.accn && same(f.val, otherRow[detector.field]));
  if (reportedTogether) return null;
  return { restated: restatedRow.label, restatedFiled: restated.by.filed, unrestated: otherRow.label };
}

function epsCheck(gaap, row, isQuarter) {
  if (!row.endDate || !finite(row.eps) || !finite(row.dilutedShares) || row.dilutedShares <= 0) return null;
  const latest = (tags) => periodFacts(gaap, tags, row.endDate, isQuarter).at(-1)?.val;
  const filed = latest(EPS_TAGS), shares = latest(SHARE_TAGS);
  if (!finite(filed) || !finite(shares) || shares <= 0) return null;
  const factor = shares / row.dilutedShares;
  const expected = filed * factor;
  const off = Math.abs(row.eps - expected);
  if (off <= Math.max(Math.abs(expected) * EPS_TOLERANCE, 0.02)) return null;
  return { filed, expected, factor };
}

/**
 * Marks rows (oldest first) where growth from the previous column crosses a
 * restatement, and where EPS disagrees with the filing. Returns the rows.
 */
function annotateStatement(rows, gaap, isQuarter) {
  if (!gaap) return rows;
  rows.forEach((cur, i) => {
    if (i > 0) {
      const fields = [];
      let found = null;
      for (const detector of DETECTORS) {
        const hit = basisBreak(gaap, detector, rows[i - 1], cur, isQuarter);
        if (hit) { fields.push(...detector.gates); found = found || hit; }
      }
      if (found) cur.basisBreak = { fields, ...found };
    }
    const eps = epsCheck(gaap, cur, isQuarter);
    if (eps) cur.epsCheck = eps;
  });
  return rows;
}

/**
 * Net margin on the profit that belongs to the revenue beside it. After a
 * business is moved to discontinued operations, revenue excludes it while net
 * income still includes its profit — Honeywell's FY2023 margin printed 17.14%
 * on that mix, against 14.89% on continuing profit.
 */
function netMarginFor({ revenue, netIncome, continuingNetIncome, discontinued }) {
  if (!finite(revenue) || revenue === 0) return { netMargin: null };
  if (finite(discontinued) && discontinued !== 0) {
    const continuing = finite(continuingNetIncome) ? continuingNetIncome
      : finite(netIncome) ? netIncome - discontinued : null;
    if (continuing != null) return { netMargin: (continuing / revenue) * 100, netMarginBasis: 'continuing', continuingNetIncome: continuing, discontinued };
  }
  return { netMargin: finite(netIncome) ? (netIncome / revenue) * 100 : null };
}

module.exports = { annotateStatement, netMarginFor, periodFacts };
