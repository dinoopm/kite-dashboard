// The US RRG universe: the sector and thematic ETFs the US Indices page plots
// against its benchmark. A copy of the list the page and the /api/us/rrg route
// each hold (frontend INDICES with category "sector", minus WQTM, whose
// history is too short for a multi-quarter window). The recorder runs with no
// page open, so it cannot be handed the list the way the route is; if a row is
// added to the page, add it here or its rotation is never recorded.
const US_RRG_KEYS = [
  'XLK', 'XLF', 'XLV', 'XLY', 'XLP', 'XLE', 'XLI', 'XLB', 'XLRE', 'XLU', 'XLC',
  'SMH', 'XBI', 'KRE', 'ITB', 'XOP', 'XRT', 'IYT', 'GLD', 'GDX', 'IGV',
  'CIBR', 'UFO', 'ITA', 'QTUM', 'HYDR', 'REMX', 'URA', 'ICLN',
];
const US_RRG_BENCHMARK = 'SPY';

module.exports = { US_RRG_KEYS, US_RRG_BENCHMARK };
