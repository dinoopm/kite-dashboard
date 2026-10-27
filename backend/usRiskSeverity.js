const { fetchSeries } = require('./macro/fred');
const { fetchVixHistory } = require('./usVix');
const { fileRuleVersion } = require('./signals/audit');
const { DEFAULT_THRESHOLDS: RULES, validateThresholds } = require('./riskSeverity/thresholds.ts');
const { classify, assess } = require('./riskSeverity/classify');
const RULE_VERSION = fileRuleVersion('us-risk-severity', [__filename, require.resolve('./riskSeverity/thresholds.ts'), require.resolve('./riskSeverity/classify')]);
const DAY = 864e5;
const finite = Number.isFinite;
const iso = value => {
  const date = new Date(value);
  return finite(+date) ? date.toISOString().slice(0, 10) : null;
};
function points(rows, key = 'close', cutoff = '9999-12-31') {
  const values = new Map();
  for (const row of rows || []) {
    const date = iso(row.date ?? row.observation_date);
    const value = row[key];
    if (date && date <= cutoff && finite(value) && (key === 'value' ? value >= 0 : value > 0)) values.set(date, { date, value });
  }
  return [...values.values()].sort((a, b) => a.date.localeCompare(b.date));
}
const rounded = (value, config) => Number(value.toFixed(config.precisionDecimals));
const pct = (a, b, config) => finite(a) && finite(b) && b > 0 ? rounded((a / b - 1) * 100, config) : null;
function classifySeverity(metrics, { stale = false, config = RULES } = {}) {
  return assess({ ...metrics, stale }, config);
}
function severityAt(prices, bonds, vol, spreads, index, config = RULES, ccc = new Map()) {
  const latest = prices[index];
  const metrics = { vix: null, rotation: null, drawdown: null, rapidDrawdown: null, creditChange21: null, creditChange4: null };
  const inputs = {};
  if (latest) {
    const monthly = prices[index - config.rotationSessions];
    const short = prices[index - config.rapidSessions];
    const highWindow = prices.slice(Math.max(0, index - config.highSessions + 1), index + 1);
    const rapidWindow = prices.slice(Math.max(0, index - config.rapidSessions), index + 1);
    const peak = highWindow.length === config.highSessions ? highWindow.reduce((a, b) => a.value >= b.value ? a : b) : null;
    const rapidPeak = rapidWindow.length === config.rapidSessions + 1 ? rapidWindow.reduce((a, b) => a.value >= b.value ? a : b) : null;
    const spyReturn = pct(latest.value, monthly?.value, config);
    const tltReturn = monthly ? pct(bonds.get(latest.date), bonds.get(monthly.date), config) : null;
    const creditNow = spreads.get(latest.date);
    Object.assign(metrics, {
      vix: vol.get(latest.date), rotation: finite(spyReturn) && finite(tltReturn) ? spyReturn - tltReturn : null,
      drawdown: pct(latest.value, peak?.value, config), rapidDrawdown: pct(latest.value, rapidPeak?.value, config),
      creditChange21: monthly && spreads.has(monthly.date) ? rounded((creditNow - spreads.get(monthly.date)) * 100, config) : null,
      creditChange4: short && spreads.has(short.date) ? rounded((creditNow - spreads.get(short.date)) * 100, config) : null,
      cccChange21: monthly && ccc.has(latest.date) && ccc.has(monthly.date) ? rounded((ccc.get(latest.date) - ccc.get(monthly.date)) * 100, config) : null,
    });
    Object.assign(inputs, { asOf: latest.date, spyClose: latest.value, tltClose: bonds.get(latest.date), spyReturn, tltReturn,
      rotationFrom: monthly?.date || null, creditOasBps: creditNow * 100, creditBase21: monthly && spreads.has(monthly.date) ? spreads.get(monthly.date) * 100 : null,
      creditBase4: short && spreads.has(short.date) ? spreads.get(short.date) * 100 : null, rapidFrom: short?.date || null,
      peak: peak || null, rapidPeak: rapidPeak || null,
      // Exact baselines, dates and values are retained for an auditable snapshot.
      spyBaseline: monthly || null, tltBaseline: monthly && bonds.has(monthly.date) ? { date: monthly.date, value: bonds.get(monthly.date) } : null,
    });
  }
  return { metrics, inputs };
}
function completedCutoff(now, config = RULES) {
  const ny = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(now));
  return hour >= config.completedCloseHourEt ? ny : iso(Date.parse(`${ny}T00:00:00Z`) - DAY);
}
function buildSeverity({ spy = [], tlt = [], vix = [], credit = [], ccc = [] }, now = new Date(), config = RULES) {
  // Include today's daily equity bar only after 17:00 New York, allowing the
  // close to settle. The common date is usually earlier because OAS is lagged.
  const cutoff = completedCutoff(now, config);
  const prices = points(spy, 'close', cutoff);
  const bonds = new Map(points(tlt, 'close', cutoff).map(p => [p.date, p.value]));
  const vol = new Map(points(vix, 'close', cutoff).map(p => [p.date, p.value]));
  const cccSpreads = new Map(points(ccc, 'value', cutoff).map(p => [p.date, p.value]));
  const spreads = new Map(points(credit, 'value', cutoff).map(p => [p.date, p.value]));
  const index = prices.findLastIndex(p => bonds.has(p.date) && vol.has(p.date) && spreads.has(p.date));
  const latest = prices[index];
  const { metrics, inputs } = severityAt(prices, bonds, vol, spreads, index, config, cccSpreads);
  const stale = Boolean(latest && (+now - Date.parse(`${latest.date}T00:00:00Z`)) / DAY > config.staleDays);
  return { ...classifySeverity(metrics, { stale, config }), metrics, inputs, asOf: latest?.date || null, stale, ruleVersion: RULE_VERSION, rules: config, fetchedAt: now.toISOString() };
}
// Reconstruction uses the same causal rule on each date. Never save these as
// recorded emissions: current credit history can contain later revisions, and
// its observation dates are not the dates the releases became available.
function buildSeverityTimeline({ spy = [], tlt = [], vix = [], credit = [], ccc = [] }, now = new Date(), config = RULES) {
  const cutoff = completedCutoff(now, config);
  const prices = points(spy, 'close', cutoff);
  const bonds = new Map(points(tlt, 'close', cutoff).map(p => [p.date, p.value]));
  const vol = new Map(points(vix, 'close', cutoff).map(p => [p.date, p.value]));
  const cccSpreads = new Map(points(ccc, 'value', cutoff).map(p => [p.date, p.value]));
  const creditPoints = points(credit, 'value', cutoff);
  const spreads = new Map(creditPoints.map(p => [p.date, p.value]));
  const series = [];
  for (let i = 0; i < prices.length; i++) {
    if (!creditPoints.length || prices[i].date < creditPoints[0].date) continue;
    const { metrics } = severityAt(prices, bonds, vol, spreads, i, config, cccSpreads);
    const { state, flags } = classifySeverity(metrics, { config });
    series.push({ date: prices[i].date, state, metrics, flags: Object.fromEntries(flags.map(f => [f.id, f.triggered])) });
  }
  const complete = series.filter(p => p.state !== 'INCOMPLETE');
  let daysInCurrentTier = 0;
  const last = series.findLast(p => p.state !== 'INCOMPLETE');
  if (last) for (let i = series.indexOf(last); i >= 0 && series[i].state === last.state; i--) daysInCurrentTier++;
  return { series, daysInCurrentTier, fromDate: complete[0]?.date || null, toDate: complete.at(-1)?.date || null,
    source: 'reconstructed',
    notice: 'Historical labels are reconstructed from daily closes and current credit history, not real-time calls or validated forecasts. Credit publication lags and revisions are not reconstructed. Days without all inputs stay unlabelled.' };
}
function inputVintages(data, results, now) {
  const source = [
    ['spy', 'SPY', 0, 'Yahoo Finance daily close'], ['tlt', 'TLT', 1, 'Yahoo Finance daily close'],
    ['vix', 'VIX', 2, 'Cboe daily close'], ['credit', 'HY OAS', 3, 'FRED BAMLH0A0HYM2'], ['ccc', 'CCC OAS (optional)', 4, 'FRED BAMLH0A3HYC'],
  ];
  return source.map(([id, label, index, provider]) => {
    const item = results[index];
    const observations = item?.status === 'fulfilled' ? item.value?.observations : null;
    const point = observations?.find(row => row.observation_date === data.asOf);
    const present = item?.status === 'fulfilled' && data.asOf && (index < 3 || point);
    return { id, label, source: provider, observationDate: present ? data.asOf : null,
      vintageDate: point?.realtime_start || null, vintage: 'current history snapshot', retrievedAt: now.toISOString(),
      availableAt: null, note: 'Historical publication time is not supplied by this live feed. Retrieval time is not the first release time.' };
  });
}
let yahoo;
async function fetchIndex(symbol, period1) {
  if (!yahoo) { const YF = require('yahoo-finance2').default; yahoo = new YF({ suppressNotices: ['yahooSurvey'] }); }
  return (await yahoo.chart(symbol, { period1, interval: '1d' }, { validateResult: false, fetchOptions: { signal: AbortSignal.timeout(25000) } })).quotes || [];
}
function createSeverityService({ indexFetch = fetchIndex, vixFetch = fetchVixHistory, creditFetch = start => fetchSeries('BAMLH0A0HYM2', { start }), cccFetch = start => fetchSeries('BAMLH0A3HYC', { start }), now = () => new Date(), config = RULES } = {}) {
  validateThresholds(config);
  let cached = null, pending = null, at = 0;
  return async function getSeverity() {
    if (cached && +now() - at < (cached.state === 'INCOMPLETE' ? 30_000 : 15 * 60_000)) return cached;
    if (pending) return pending;
    pending = (async () => {
      const start = new Date(+now() - 5 * 366 * DAY);
      const result = await Promise.allSettled([indexFetch('SPY', start), indexFetch('TLT', start), vixFetch(), creditFetch(iso(start)), config.enableCccCrossCheck ? cccFetch(iso(start)) : Promise.resolve({ observations: [] })]);
      const raw = { spy: result[0].value || [], tlt: result[1].value || [], vix: result[2].value || [], credit: result[3].value?.observations || [], ccc: result[4].value?.observations || [] };
      const data = buildSeverity(raw, now(), config);
      data.timeline = buildSeverityTimeline(raw, now(), config);
      data.daysInCurrentTier = data.state === 'INCOMPLETE' ? null : data.timeline.daysInCurrentTier;
      data.vintages = inputVintages(data, result, now());
      data.warnings = result.flatMap((r, i) => r.status === 'rejected' ? [`${['SPY', 'TLT', 'Cboe VIX history', 'FRED high-yield OAS', 'Optional CCC OAS'][i]} could not be loaded.`] : []);
      const registry = require('./signals/registry').signalMeta('us_risk_severity');
      data.validation = { signal: 'us_risk_severity', ruleVersion: RULE_VERSION, source: 'recorded', headline: { state: 'unscoreable', text: 'Unvalidated severity rule', detail: registry.blockedReason }, description: registry.description, horizons: [] };
      data.validation = await require('./riskSeverity/validation').validationBadge(data.validation, RULE_VERSION, config);
      data.flagValidation = Object.fromEntries(data.flags.map(flag => [flag.id, { signal: flag.signal, headline: { state: 'unscoreable', text: 'Unvalidated flag', detail: require('./signals/registry').signalMeta(flag.signal)?.blockedReason || 'No measured forward track record exists.' } }]));
      cached = data; at = +now(); return data;
    })().finally(() => { pending = null; });
    return pending;
  };
}
const getUsRiskSeverity = createSeverityService();
async function getAndRecordUsRiskSeverity() {
  const data = await getUsRiskSeverity();
  if (data.state === 'INCOMPLETE') return { ...data, recording: { skipped: 'incomplete inputs' } };
  try { const recorder = require('./signals/record'); const recording = await recorder.recordUsRiskSeverity(data); recording.flags = await recorder.recordUsRiskFlags(data); return { ...data, recording }; }
  catch { return { ...data, recording: { error: 'Severity transition could not be saved; recording will retry.' } }; }
}
module.exports = { classify, assess, severityAt, completedCutoff, RULES, RULE_VERSION, points, classifySeverity, buildSeverity, buildSeverityTimeline, createSeverityService, getUsRiskSeverity, getAndRecordUsRiskSeverity };
