'use strict';

const { normalizeEmission, versionEmission } = require('./signals/audit');
const { scoreSignal, forwardOutcome, indexOfDate, DEFAULT_COST_MODEL } = require('./signalScoring');

const HORIZONS = [5, 10, 22];
const MIN_SAMPLE = 20;
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });

function alertEmission(alert, ruleVersion, observedAt) {
  observedAt = alert.signalInputs?.evaluatedAt || observedAt;
  const action = alert.tradePlan?.action || 'HOLD / WAIT';
  const exchange = String(alert.signalInputs?.holding?.exchange || 'NSE').toUpperCase();
  return versionEmission({
    signal: `technical_alert/${action}/${exchange}`,
    snap_date: dateFormatter.format(new Date(observedAt)),
    symbol: alert.symbol,
    source: 'recorded',
    meta: {
      action, exchange, observedAt, candleAsOf: alert.candleAsOf || alert.signalInputs?.candleAsOf || null,
      score: alert.confidence, scoreScale: '/100', scoreType: 'heuristic-bullish-bias',
      output: JSON.parse(JSON.stringify(alert)),
      entryPrice: alert.price, costModel: { ...DEFAULT_COST_MODEL },
      sampling: 'first-observation-per-action-symbol-day-version',
    },
  }, ruleVersion, alert.signalInputs);
}

function summarizeObservations(rows, context, currentRuleVersion, generatedAt) {
  const emissions = rows.map(normalizeEmission).map(e => ({
    ...e, action: e.meta.action, entryPrice: e.meta.entryPrice, costModel: e.meta.costModel,
  }));
  const groups = new Map();
  for (const emission of emissions) {
    emission.scoreBand = emission.meta.score < 40 ? '0–39' : emission.meta.score > 75 ? '76–100' : '40–75';
    const key = `${emission.ruleVersion}|${emission.action}|${emission.scoreBand}|${emission.meta.exchange || 'NSE'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(emission);
  }
  const round = value => value == null ? null : +value.toFixed(2);
  const supportedSeries = emission => (emission.meta.exchange || 'NSE') === 'NSE'
    ? context.seriesBySymbol[emission.symbol] : undefined;
  return {
    currentRuleVersion,
    generatedAt,
    params: { horizons: HORIZONS, minSample: MIN_SAMPLE, costModel: DEFAULT_COST_MODEL, entry: 'observed quote', adverseBasis: 'subsequent session lows' },
    calendarGaps: context.calendarGaps || [],
    groups: [...groups.values()].map(group => ({
      ruleVersion: group[0].ruleVersion,
      currentRules: group[0].ruleVersion === currentRuleVersion,
      action: group[0].action,
      exchange: group[0].meta.exchange || 'NSE',
      scoreBand: group[0].scoreBand,
      observations: group.length,
      symbols: new Set(group.map(e => e.symbol)).size,
      horizons: Object.entries(scoreSignal(group.map(emission => ({ ...emission,
        symbol: supportedSeries(emission) ? emission.symbol : `unsupported:${emission.symbol}`,
      })), context.seriesBySymbol, { horizons: HORIZONS, costModel: DEFAULT_COST_MODEL }))
        .map(([horizon, stats]) => ({
          horizon, n: stats.n, unresolved: stats.unresolved, underSampled: stats.n < MIN_SAMPLE,
          medianGrossPct: round(stats.medianPct), medianNetPct: round(stats.medianNetPct),
          netGainRatePct: round(stats.hitRateNet === null ? null : stats.hitRateNet * 100),
          medianMaxAdversePct: round(stats.medianMaxAdversePct), worstMaxAdversePct: round(stats.worstMaxAdversePct),
          nAdverse: stats.nAdverse, adverseUnresolved: stats.adverseUnresolved,
          outcomesAfterCosts: stats.outcomesAfterCosts,
        })),
    })),
    recentObservations: [...emissions].sort((a, b) => String(b.meta.observedAt).localeCompare(String(a.meta.observedAt))).slice(0, 20).map(emission => ({
      symbol: emission.symbol, exchange: emission.meta.exchange || 'NSE', action: emission.action, ruleVersion: emission.ruleVersion,
      observedAt: emission.meta.observedAt, candleAsOf: emission.meta.candleAsOf,
      score: emission.meta.score, entryPrice: emission.entryPrice, costModel: emission.costModel,
      inputsRecorded: emission.inputsRecorded,
      // Full causal OHLCV inputs stay in the immutable database record. Show
      // the derived values beside outcomes without returning years of bars.
      inputs: emission.inputs?.metrics || null,
      outcomes: Object.fromEntries(HORIZONS.map(horizon => [
        `${horizon}d`, forwardOutcome(supportedSeries(emission),
          indexOfDate(supportedSeries(emission), emission.date), horizon,
          { entryPrice: emission.entryPrice, costModel: emission.costModel || DEFAULT_COST_MODEL }),
      ])),
    })),
    caveats: [
      'These are daily state observations, not independent trades. Repeated holdings and overlapping horizons reduce the effective sample size.',
      'Returns model a hypothetical long holding from the observed quote to the horizon close, including for bearish warnings; no short trades or stop/target execution are assumed.',
      'Fees of 10 bps and slippage of 5 bps per side are illustrative assumptions frozen with each observation, not actual broker charges.',
      'Adverse moves use lows of later sessions only; missing session lows leave adverse moves unresolved. Missing endpoints and non-session observation dates leave returns unresolved.',
      'Historical prices are not split-adjusted here; corporate actions can distort outcomes. Heuristic scores are points out of 100, not calibrated probabilities.',
      'Outcome prices are NSE bhavcopy. BSE and unsupported listings remain unresolved instead of borrowing another exchange’s prices.',
    ],
  };
}

function createAlertAuditService({ ruleVersion, store, fetchRows, context, now = () => new Date() }) {
  const savedKeys = new Set();
  let recording = Promise.resolve();
  return {
    async record(alerts) {
      if (!store) return { status: 'unavailable', message: 'Signal recording requires the configured database.' };
      const observedAt = now().toISOString();
      const rows = alerts.map(alert => alertEmission(alert, ruleVersion, observedAt));
      // Coalesce concurrent API reads, and avoid duplicate writes each minute.
      const work = recording.then(async () => {
        const pending = rows.filter(row => !savedKeys.has(`${row.signal}|${row.snap_date}|${row.symbol}`));
        if (!pending.length) return { status: 'unchanged', observationsStored: 0 };
        try {
          const count = await store(pending);
          for (const row of pending) savedKeys.add(`${row.signal}|${row.snap_date}|${row.symbol}`);
          if (savedKeys.size > 10000) savedKeys.clear();
          return { status: 'recorded', observationsStored: count };
        } catch (error) {
          return { status: 'failed', message: `Signal recording failed: ${error.message}` };
        }
      });
      recording = work.then(() => undefined);
      return work;
    },
    async trackRecord() {
      if (!fetchRows) throw Object.assign(new Error('Signal recording database is unavailable'), { statusCode: 503 });
      const rows = await fetchRows();
      const firstDate = rows.reduce((first, row) => row.snap_date < first ? row.snap_date : first, rows[0]?.snap_date);
      const ctx = rows.length ? await context([...new Set(rows.map(row => row.symbol))], firstDate) : { seriesBySymbol: {} };
      return summarizeObservations(rows, ctx, ruleVersion, now().toISOString());
    },
  };
}

module.exports = { createAlertAuditService, alertEmission, summarizeObservations };
