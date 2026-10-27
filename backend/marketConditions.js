// Independent observations for understanding market conditions. These are
// descriptive comparisons, never a combined score or a return forecast.
const { fetchMany } = require('./macro/fred');

const DAY = 86400000;
const DEFINITIONS = [
  { id: 'nfci', seriesId: 'NFCI', title: 'Financial conditions', unit: 'index', staleDays: 14, baselineTolerance: 10,
    source: { label: 'Chicago Fed · FRED NFCI', url: 'https://fred.stlouisfed.org/series/NFCI' },
    description: 'A weekly view of credit, funding and market conditions. Zero is the historical average.' },
  { id: 'credit', seriesId: 'BAMLH0A0HYM2', title: 'Corporate credit stress', unit: 'percent', staleDays: 7, baselineTolerance: 7,
    source: { label: 'ICE BofA · FRED', url: 'https://fred.stlouisfed.org/series/BAMLH0A0HYM2' },
    description: 'The extra yield on US high-yield corporate bonds over Treasuries, adjusted for embedded options.' },
  { id: 'realYield', seriesId: 'DFII10', title: '10-year real yield', unit: 'percent', staleDays: 7, baselineTolerance: 7,
    source: { label: 'Federal Reserve · FRED DFII10', url: 'https://fred.stlouisfed.org/series/DFII10' },
    description: 'The market yield on 10-year inflation-protected Treasuries. A rising real yield can pressure equity valuations.' },
  { id: 'sp500', symbol: '^GSPC', title: 'S&P 500 trend', unit: 'points', staleDays: 7, baselineTolerance: 7,
    source: { label: 'Yahoo Finance · S&P 500', url: 'https://finance.yahoo.com/quote/%5EGSPC/' },
    description: 'The index close relative to its average over the latest 200 trading observations.' },
  { id: 'nasdaq100', symbol: '^NDX', title: 'Nasdaq 100 trend', unit: 'points', staleDays: 7, baselineTolerance: 7,
    source: { label: 'Yahoo Finance · Nasdaq 100', url: 'https://finance.yahoo.com/quote/%5ENDX/' },
    description: 'The index close relative to its average over the latest 200 trading observations.' },
];

function dateOnly(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
  if (typeof value !== 'string') return null;
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

// Clamp month ends: May 31 minus three months is February 28/29, not March 3.
function monthsBefore(date, months) {
  const d = new Date(`${dateOnly(date)}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

function normalizePoints(rows, { today, price = false, completedBefore = null } = {}) {
  const points = new Map();
  for (const row of rows || []) {
    const date = dateOnly(row.date ?? row.observation_date);
    const value = price ? row.close : row.value;
    if (!date || !Number.isFinite(value) || (price && value <= 0)) continue;
    if ((today && date > today) || (completedBefore && date >= completedBefore)) continue;
    points.set(date, { date, value });
  }
  return [...points.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function changeOverThreeMonths(points, definition) {
  const latest = points.at(-1);
  if (!latest) return null;
  const cutoffDate = monthsBefore(latest.date, 3);
  const baseline = points.findLast(point => point.date <= cutoffDate);
  if (!baseline || (Date.parse(cutoffDate) - Date.parse(baseline.date)) / DAY > definition.baselineTolerance) return null;
  const price = Boolean(definition.symbol);
  const value = price ? (latest.value / baseline.value - 1) * 100
    : (latest.value - baseline.value) * (definition.unit === 'percent' ? 100 : 1);
  return {
    value: Number(value.toFixed(6)), unit: price ? 'percent' : definition.unit === 'percent' ? 'bps' : 'index',
    fromDate: baseline.date, toDate: latest.date, cutoffDate,
  };
}

function sampleHistory(points) {
  if (points.length <= 65) return points;
  return Array.from({ length: 65 }, (_, i) => points[Math.round(i * (points.length - 1) / 64)]);
}

function missingSignal(definition, reason) {
  return {
    id: definition.id, title: definition.title, unit: definition.unit,
    description: definition.description, source: definition.source || null,
    status: 'unavailable', value: null, asOf: null, stale: false,
    level: { label: 'Unavailable', description: reason, tone: 'neutral' },
    direction: { label: 'No comparison', description: reason, tone: 'neutral' },
    change3m: null, history: [], movingAverage200: null, distanceFromAveragePct: null,
    observationCount: 0, error: reason,
  };
}

function levelFor(definition, value, average) {
  if (definition.id === 'nfci') {
    return { label: value < 0 ? 'Looser than average' : value > 0 ? 'Tighter than average' : 'At historical average',
      description: 'This compares the current level with the historical average, not with last quarter.',
      tone: value < 0 ? 'positive' : value > 0 ? 'negative' : 'neutral' };
  }
  if (definition.symbol) {
    if (average == null) return { label: '200-day trend unavailable', description: 'At least 200 valid daily closing observations are required.', tone: 'neutral' };
    return { label: value > average ? 'Above 200-day average' : value < average ? 'Below 200-day average' : 'At 200-day average',
      description: 'A trend check for this index; it does not measure how many individual stocks are participating.',
      tone: value > average ? 'positive' : value < average ? 'negative' : 'neutral' };
  }
  if (definition.id === 'credit') return { label: 'High-yield risk premium', description: 'Read the change alongside financial conditions. The level alone is not a buy or sell threshold.', tone: 'neutral' };
  return { label: value < 0 ? 'Negative real yield' : value > 0 ? 'Positive real yield' : 'Zero real yield',
    description: 'A market-based inflation-adjusted yield. Zero is not an estimate of neutral monetary policy.', tone: 'neutral' };
}

function directionFor(definition, change, stale) {
  if (stale) return { label: 'Update overdue', description: 'The latest observation is old. Treat the comparison as historical.', tone: 'neutral' };
  if (!change) return { label: '3-month comparison unavailable', description: 'No valid observation close enough to the three-month baseline.', tone: 'neutral' };
  const sign = Math.sign(change.value);
  const tone = sign === 0 ? 'neutral' : (definition.symbol ? sign > 0 : sign < 0) ? 'positive' : 'negative';
  const names = definition.id === 'nfci' ? ['Easing', 'Tightening']
    : definition.id === 'credit' ? ['Narrowing', 'Widening']
      : definition.id === 'realYield' ? ['Falling', 'Rising'] : ['Falling', 'Rising'];
  return { label: sign === 0 ? 'Unchanged' : names[sign > 0 ? 1 : 0],
    description: definition.id === 'nfci' ? 'An increase means conditions tightened over the period, even if the level remains below zero.'
      : definition.id === 'credit' ? 'A wider spread means investors demand more compensation for corporate credit risk.'
        : definition.id === 'realYield' ? 'Higher real yields can make future company earnings less valuable today.'
          : 'Price change over approximately three calendar months, excluding dividends.', tone };
}

function buildSignal(definition, rows, now = new Date(), error = null) {
  // A quote from today's session can still be moving. Use prior New York dates
  // consistently, so the trend always uses completed daily observations.
  const marketDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const points = normalizePoints(rows, { today: dateOnly(now), price: Boolean(definition.symbol), completedBefore: definition.symbol ? marketDate : null });
  if (!points.length) return missingSignal(definition, error || 'No valid observations returned by the source.');
  const latest = points.at(-1);
  const stale = (Date.parse(dateOnly(now)) - Date.parse(latest.date)) / DAY > definition.staleDays;
  const average = definition.symbol && points.length >= 200 ? points.slice(-200).reduce((sum, point) => sum + point.value, 0) / 200 : null;
  const change3m = changeOverThreeMonths(points, definition);
  const level = levelFor(definition, latest.value, average);
  if (stale) level.tone = 'neutral';
  return {
    id: definition.id, title: definition.title, unit: definition.unit,
    description: definition.description, source: definition.source,
    status: stale ? 'stale' : (definition.symbol && average == null) || !change3m ? 'partial' : 'available',
    value: latest.value, asOf: latest.date, stale, level, direction: directionFor(definition, change3m, stale),
    change3m, history: sampleHistory(points), movingAverage200: average,
    distanceFromAveragePct: average == null ? null : (latest.value / average - 1) * 100,
    observationCount: points.length, error: error || null,
  };
}

let yahoo;
async function fetchIndex(symbol, options) {
  if (!yahoo) {
    const YahooFinance = require('yahoo-finance2').default;
    yahoo = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  }
  const result = await yahoo.chart(symbol, { period1: options.period1, interval: '1d' }, {
    validateResult: false, fetchOptions: { signal: AbortSignal.timeout(25000) },
  });
  return result.quotes || [];
}

const METHODOLOGY = [
  'Read each measure separately. These observations are not a return forecast or a combined buy/sell score.',
  'Three-month changes use the last observation on or before three calendar months prior to each series’ latest date. Actual comparison dates are shown.',
  'NFCI changes are index points. Credit-spread and real-yield changes are basis points (100 bps = 1 percentage point). Index changes are price returns without dividends.',
  'NFCI below zero means looser than the historical average; a rising NFCI still means tightening. Historical NFCI observations can be revised.',
  'Trend averages use 200 valid daily closes. Current New York session data are excluded. Index trend is distinct from market breadth.',
  'Daily readings more than 7 calendar days old and weekly NFCI readings more than 14 calendar days old are flagged as overdue.',
];

function createMarketConditionsService({ fredFetchMany = fetchMany, indexFetch = fetchIndex, now = () => new Date() } = {}) {
  let cache = null;
  let inFlight = null;
  async function load() {
    const date = now();
    const start = monthsBefore(date, 15);
    const macro = DEFINITIONS.filter(definition => definition.seriesId);
    const prices = DEFINITIONS.filter(definition => definition.symbol);
    // A failed provider leaves the other provider's useful observations intact.
    const results = await Promise.allSettled([
      fredFetchMany(macro.map(definition => definition.seriesId), { start }),
      ...prices.map(definition => indexFetch(definition.symbol, { period1: new Date(date.getTime() - 450 * DAY) })),
    ]);
    const fred = results[0].status === 'fulfilled' ? results[0].value : { series: {}, errors: {} };
    const fredError = results[0].status === 'rejected' ? 'FRED observations could not be loaded.' : null;
    const signals = macro.map(definition => buildSignal(definition, fred.series?.[definition.seriesId]?.observations, date,
      fredError || (fred.errors?.[definition.seriesId] ? 'This FRED series could not be loaded.' : null)));
    prices.forEach((definition, index) => {
      const result = results[index + 1];
      signals.push(buildSignal(definition, result.status === 'fulfilled' ? result.value : [], date,
        result.status === 'rejected' ? 'Index price history could not be loaded.' : null));
    });
    const available = signals.filter(signal => signal.status === 'available').length;
    const values = signals.filter(signal => signal.value != null).length;
    const status = available === 5 ? 'available' : values ? 'partial' : 'unavailable';
    signals.push(
      missingSignal({ id: 'breadth', title: 'Market breadth', unit: 'percent', description: 'How many stocks participate: the share of index members above their 200-day averages.' }, 'A current, coverage-checked breadth snapshot is not included yet.'),
      missingSignal({ id: 'earnings', title: 'Earnings revisions', unit: 'percent', description: 'Whether analysts are raising or cutting company profit forecasts across the market.' }, 'A reliable index-wide earnings revision series is not connected.'),
    );
    const data = { fetchedAt: now().toISOString(), status, signals, methodology: METHODOLOGY };
    // Optional, explicitly absent gauges do not make the five requested feeds
    // a failure. Partial source failures and stale observations retry promptly.
    cache = { data, at: now().getTime(), ttl: status === 'available' ? 15 * 60 * 1000 : 30 * 1000 };
    return data;
  }
  return async function getMarketConditions() {
    if (cache && now().getTime() - cache.at < cache.ttl) return cache.data;
    if (!inFlight) inFlight = load().finally(() => { inFlight = null; });
    return inFlight;
  };
}

const getMarketConditions = createMarketConditionsService();
module.exports = { getMarketConditions, createMarketConditionsService, buildSignal, monthsBefore, normalizePoints, changeOverThreeMonths, DEFINITIONS };
