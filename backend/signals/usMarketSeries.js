// ─── Shared price plumbing for the US scorers ────────────────────────────────
//
// The US sibling of marketSeries.js: a trading calendar, per-symbol closes laid
// onto it, and a benchmark on the same one. A separate module rather than a
// `market` flag threaded through the Indian one, because nothing about the two
// is shared beyond the shape — different source, different benchmark, and a
// calendar that comes from the benchmark's own bars instead of a price table
// that drops sessions.
//
// `calendarGaps` is reported for symmetry with the Indian scorer. Alpaca's
// daily bars have not shown holes; if they ever do, this is where it would
// surface, on the same field the UI already knows how to render.

const { fetchBarsMulti } = require('../alpacaData');
const { alignToCalendar } = require('./marketSeries');

const BENCHMARK = 'SPY';

async function buildUsMarketContext(symbols, since) {
  const raw = await fetchBarsMulti([...new Set([...symbols, BENCHMARK])], new Date(since));
  const byDate = (arr) => new Map((arr || []).map(b => [String(b.date).slice(0, 10), b.close]));
  const bench = byDate(raw[BENCHMARK]);
  const calendar = [...bench.keys()].filter(d => d >= since).sort();
  const seriesBySymbol = {};
  for (const s of symbols) seriesBySymbol[s] = alignToCalendar(calendar, byDate(raw[s]));
  return {
    calendar,
    calendarGaps: [],
    seriesBySymbol,
    benchmark: alignToCalendar(calendar, bench),
    benchmarkSymbol: BENCHMARK,
  };
}

module.exports = { BENCHMARK, buildUsMarketContext };
