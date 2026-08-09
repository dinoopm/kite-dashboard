// ─── The macro series catalogue ──────────────────────────────────────────────
//
// One place that says which official series the monitor reads, what each one
// actually is, and — the part that matters — WHICH TRANSFORM it gets. Deciding
// that at the call site is how a rate ends up percent-changed; declaring it
// here means calc.js can throw on a series that never chose.
//
// Everything is sourced from FRED, which redistributes the primary series from
// BLS (CPI, payrolls, unemployment, earnings), BEA (PCE), EIA (oil) and the
// Fed Board (breakevens). Going through FRED rather than five separate APIs
// buys one auth story, one date convention and one missing-value convention;
// `originalSource` records who actually produces each number.
//
// Release lags and revisions are recorded per series because they change how
// the numbers may be read, not as documentation:
//
//   · Core PCE lands ~30 days after its reference month and core CPI ~13, so
//     at any moment the two describe DIFFERENT months. Comparing "latest CPI"
//     with "latest PCE" without checking the reference month compares August
//     with July and calls the gap a divergence.
//   · Payrolls are revised in each of the next two releases and then again at
//     the annual QCEW benchmark, which has moved by more than 500k.
//   · The seasonally-adjusted CPI and unemployment series are revised every
//     February when seasonal factors are re-estimated, so a value you stored
//     six months ago can change with no new observation arriving.
//
// That last one is why observations are stored by vintage rather than
// overwritten (migrate_macro_observations.js).

const SERIES = [
  {
    id: 'PCEPILFE',
    key: 'corePce',
    label: 'Core PCE price index',
    originalSource: 'BEA',
    frequency: 'monthly',
    unit: 'Index 2017=100',
    transform: 'index',
    releaseLagDays: 30,
    revisionRisk: 'high',
    note: 'The Fed\'s target measure. Revised most months plus annual and comprehensive NIPA updates — never treat a print as final.',
  },
  {
    id: 'CPILFESL',
    key: 'coreCpi',
    label: 'Core CPI (ex food & energy)',
    originalSource: 'BLS',
    frequency: 'monthly',
    unit: 'Index 1982-84=100',
    transform: 'index',
    releaseLagDays: 13,
    revisionRisk: 'low',
    note: 'The NSA index is never revised; this SA series is revised each February when seasonal factors are re-estimated. Publishes ~2 weeks before core PCE, so it leads.',
  },
  {
    id: 'PAYEMS',
    key: 'payrolls',
    // Named in full because the distinction is not cosmetic: total nonfarm and
    // private payrolls (USPRIV) tell different stories in the same month. Over
    // May-Jul 2026, PAYEMS averaged +20k/month while USPRIV averaged +40.3k —
    // government shedding jobs against private hiring. A card labelled just
    // "Nonfarm payrolls" leaves a reader unable to tell which they are seeing.
    label: 'Total nonfarm payrolls',
    originalSource: 'BLS',
    frequency: 'monthly',
    unit: 'Thousands of persons',
    transform: 'count',
    releaseLagDays: 5,
    revisionRisk: 'high',
    note: 'A LEVEL, not a change — the monthly headline is the first difference. Revised in each of the next two releases plus the annual QCEW benchmark.',
  },
  {
    id: 'UNRATE',
    key: 'unemployment',
    label: 'Unemployment rate',
    originalSource: 'BLS',
    frequency: 'monthly',
    unit: 'Percent',
    transform: 'rate',
    releaseLagDays: 5,
    revisionRisk: 'low',
    note: 'Already a percent — percentage-point change only. Revised with annual seasonal factors.',
  },
  {
    id: 'CES0500000003',
    key: 'wages',
    label: 'Average hourly earnings, total private',
    originalSource: 'BLS',
    frequency: 'monthly',
    unit: 'Dollars per hour',
    transform: 'index',
    releaseLagDays: 5,
    revisionRisk: 'medium',
    note: 'A dollar level, so year-over-year percent is the wage-growth figure. Composition shifts distort it — a wave of low-wage hiring mechanically lowers average earnings without anyone taking a pay cut.',
  },
  {
    id: 'DCOILWTICO',
    key: 'oil',
    label: 'WTI crude oil spot',
    originalSource: 'EIA',
    frequency: 'daily',
    unit: 'USD per barrel',
    transform: 'price',
    // Measured, not assumed: on 2026-08-09 FRED's newest DCOILWTICO bar was
    // 2026-08-03. This series is not a live quote — EIA publishes it with a
    // multi-day lag — and a lag of 1 marked it permanently "behind".
    releaseLagDays: 5,
    revisionRisk: 'none',
    note: 'Returns an empty field on US holidays and weekends, and reaches FRED several days late — it is a settled spot reference, not a live quote. Not revised.',
  },
  {
    id: 'T5YIFR',
    key: 'expectations',
    label: '5-year, 5-year forward inflation expectation',
    originalSource: 'Federal Reserve Board',
    frequency: 'daily',
    unit: 'Percent',
    transform: 'rate',
    releaseLagDays: 1,
    revisionRisk: 'none',
    note: 'Market-implied, from TIPS breakevens. Preferred over the 5-year breakeven because it strips the next five years of realised inflation and isolates the longer-run anchor.',
  },
  {
    id: 'MICH',
    key: 'expectationsSurvey',
    label: 'U. Michigan 1-year inflation expectation',
    originalSource: 'University of Michigan',
    frequency: 'monthly',
    unit: 'Percent',
    transform: 'rate',
    // Preliminary lands mid-month for the CURRENT month, final at month end,
    // so a lag of 0 expects the current month and FRED holding only the prior
    // one reads as a release behind. That is the state worth surfacing: the
    // series' FRED update genuinely trails its own publication. Refreshed
    // around both release windows rather than on a generic monthly tick, so a
    // preliminary is not missed for a fortnight.
    releaseLagDays: 0,
    refreshDaysOfMonth: [16, 17, 18, 28, 29, 30, 31],
    revisionRisk: 'medium',
    scored: false,
    note: 'Survey-based: preliminary mid-month, final at month end. NOT scored — carried for the narrative only, because households and markets routinely disagree and averaging that away hides the more interesting fact. The Expectations score is the market-based 5y5y breakeven (T5YIFR) alone.',
  },
  // Headline measures. Not scored: including them alongside core would count
  // energy twice, once in the oil signal and again inside headline inflation.
  // Carried so the narrative can explain a headline/core divergence.
  {
    id: 'CPIAUCSL',
    key: 'headlineCpi',
    label: 'Headline CPI',
    originalSource: 'BLS',
    frequency: 'monthly',
    unit: 'Index 1982-84=100',
    transform: 'index',
    releaseLagDays: 13,
    revisionRisk: 'low',
    scored: false,
    note: 'Context only — what people actually experience, and what oil moves first.',
  },
];

const SCORED_SERIES = SERIES.filter(s => s.scored !== false);
const seriesById = (id) => SERIES.find(s => s.id === id) || null;
const seriesByKey = (key) => SERIES.find(s => s.key === key) || null;

module.exports = { SERIES, SCORED_SERIES, seriesById, seriesByKey };
