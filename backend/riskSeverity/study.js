const { DEFAULT_THRESHOLDS } = require('./thresholds.ts');
const { validateThresholds } = require('./thresholds.ts');
const TIERS = ['NEUTRAL', 'CAUTION', 'STRESS', 'CRASH MODE', 'MIXED', 'INCOMPLETE'];
const median = values => { if (!values.length) return null; const a = [...values].sort((x, y) => x - y), i = Math.floor(a.length / 2); return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2; };
// Non-overlapping 10% directional-change episodes allow a new correction
// inside a long recovery (e.g. 2011 before the 2007 all-time high was reclaimed).
function drawdownEpisodes(rows, config = DEFAULT_THRESHOLDS) {
  const events = []; if (!rows.length) return events;
  let peak = 0, trough = 0, active = null;
  for (let i = 1; i < rows.length; i++) {
    const price = rows[i].spyClose;
    if (!active) {
      if (price >= rows[peak].spyClose) peak = i;
      if ((1 - price / rows[peak].spyClose) * 100 >= config.outcomeDrawdownPct - 10 ** -config.precisionDecimals) {
        active = { peak, breach: i, trough: i, recovered: null }; trough = i;
      }
    } else {
      if (price < rows[trough].spyClose) { trough = i; active.trough = i; }
      if ((price / rows[trough].spyClose - 1) * 100 >= config.outcomeDrawdownPct - 10 ** -config.precisionDecimals) {
        active.recovered = i; events.push(active); active = null; peak = i;
      }
    }
  }
  if (active) events.push(active);
  return events;
}
function forwardDrawdown(rows, index, sessions) {
  let peak = rows[index].spyClose, worst = 0;
  for (let i = index + 1; i <= index + sessions; i++) { peak = Math.max(peak, rows[i].spyClose); worst = Math.min(worst, rows[i].spyClose / peak - 1); }
  return worst * 100;
}
function tierStatistics(rows, config = DEFAULT_THRESHOLDS) {
  const events = drawdownEpisodes(rows, config);
  return TIERS.map(tier => {
    const indexes = rows.flatMap((row, i) => row.tier === tier ? [i] : []);
    const eligible = indexes.filter(i => i + config.outcomeWindowSessions < rows.length);
    const falsePositives = eligible.filter(i => forwardDrawdown(rows, i, config.outcomeWindowSessions) > -config.outcomeDrawdownPct + 10 ** -config.precisionDecimals).length;
    const starts = indexes.filter(i => i === 0 || rows[i - 1].tier !== tier);
    const firstByEvent = new Map();
    for (const reading of starts) {
      // First bind to an already-active drawdown, so a late warning is never
      // credited with leading some unrelated future episode.
      let eventIndex = events.findIndex(event => event.peak <= reading && reading <= (event.recovered ?? rows.length - 1));
      if (eventIndex < 0) eventIndex = events.findIndex(event => event.breach > reading && event.breach - reading <= config.outcomeWindowSessions);
      if (eventIndex < 0 || firstByEvent.has(eventIndex)) continue;
      const event = events[eventIndex];
      if (event.breach - reading > config.outcomeWindowSessions) continue;
      firstByEvent.set(eventIndex, { sessions: event.breach - reading, days: (Date.parse(rows[event.breach].date) - Date.parse(rows[reading].date)) / 864e5, reading: rows[reading].date, breach: rows[event.breach].date });
    }
    const leads = [...firstByEvent.values()];
    return { tier, days: indexes.length, baseRatePct: rows.length ? indexes.length / rows.length * 100 : null,
      resolvedReadings: eligible.length, censoredReadings: indexes.length - eligible.length, falsePositives,
      falsePositiveRatePct: eligible.length ? falsePositives / eligible.length * 100 : null,
      leadEvents: leads.length, medianLeadSessions: median(leads.map(l => l.sessions)), medianLeadCalendarDays: median(leads.map(l => l.days)), leads };
  });
}
const rank = tier => ({ NEUTRAL: 0, CAUTION: 1, MIXED: 0, STRESS: 2, 'CRASH MODE': 3 })[tier];
function allocationState(config = DEFAULT_THRESHOLDS) {
  return { exposure: config.normalExposure, heldRisk: 0, below: 0 };
}
function nextAllocation(state, tier, config = DEFAULT_THRESHOLDS) {
  const severity = rank(tier);
  if (severity == null) return { ...state, below: 0 }; // missing data is not recovery
  if (severity >= 2 && severity >= state.heldRisk) return { exposure: severity === 3 ? config.crashExposure : config.stressExposure, heldRisk: severity, below: 0 };
  if (state.heldRisk < 2) return { ...state, below: 0 };
  const below = state.below + 1;
  if (below < config.reentrySessions) return { ...state, below };
  return severity === 2 ? { exposure: config.stressExposure, heldRisk: 2, below: 0 } : allocationState(config);
}
function rebalance(account, open, target, fee) {
  const equity = account.cash + account.shares * open, invested = account.shares * open;
  const buy = target * equity >= invested;
  const turnover = buy ? (target * equity - invested) / (1 + target * fee) : (invested - target * equity) / (1 - target * fee);
  const cost = Math.max(0, turnover) * fee;
  const notional = invested + (buy ? turnover : -turnover);
  return { shares: notional / open, cash: equity - notional - cost, cost };
}
function curveMetrics(curve, config = DEFAULT_THRESHOLDS) {
  if (!curve.length) return { cagrPct: null, maxDrawdownPct: null, sharpe: null };
  let previous = 1, peak = 1, worst = 0; const returns = [];
  for (const point of curve) { returns.push(point.equity / previous - 1); previous = point.equity; peak = Math.max(peak, point.equity); worst = Math.min(worst, point.equity / peak - 1); }
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const sd = returns.length > 1 ? Math.sqrt(returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1)) : 0;
  const days = (Date.parse(curve.at(-1).date) - Date.parse(curve[0].date)) / 864e5;
  return { cagrPct: days > 0 ? (curve.at(-1).equity ** (365.25 / days) - 1) * 100 : null, maxDrawdownPct: worst * 100,
    sharpe: sd > 0 ? mean / sd * Math.sqrt(config.sessionsPerYear) : null };
}
function strategyComparison(rows, config = DEFAULT_THRESHOLDS) {
  validateThresholds(config);
  const fee = config.turnoverCostBps / 10000;
  let allocation = allocationState(config), strategy = { shares: 0, cash: 1 }, hold = { shares: 0, cash: 1 }, totalCosts = 0, holdCosts = 0;
  const curve = [], holdCurve = [], trades = [];
  let previousTarget = config.normalExposure, previousDirection = 0, previousTrade = null, whipsaws = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // Allocation was chosen after the PREVIOUS close; today's close cannot
    // change today's opening exposure. Missing-assessment days preserve it.
    const target = allocation.exposure;
    strategy = rebalance(strategy, row.spyOpen, target, fee); totalCosts += strategy.cost;
    if (i === 0) { hold = rebalance(hold, row.spyOpen, config.normalExposure, fee); holdCosts += hold.cost; }
    if (i > 0 && target !== previousTarget) {
      const direction = Math.sign(target - previousTarget);
      if (previousTrade != null && i - previousTrade <= config.whipsawWindowSessions && direction !== previousDirection) whipsaws++;
      trades.push({ date: row.date, from: previousTarget, to: target, decisionDate: rows[i - 1].date });
      previousTrade = i; previousDirection = direction;
    }
    previousTarget = target;
    curve.push({ date: row.date, equity: strategy.cash + strategy.shares * row.spyClose, exposure: target });
    holdCurve.push({ date: row.date, equity: hold.cash + hold.shares * row.spyClose, exposure: config.normalExposure });
    allocation = nextAllocation(allocation, row.tier, config);
  }
  return { strategy: { name: 'Severity de-risking', ...curveMetrics(curve, config), whipsaws, allocationChanges: trades.length, cost: totalCosts },
    buyHold: { name: 'Buy-and-hold SPY', ...curveMetrics(holdCurve, config), whipsaws: 0, allocationChanges: 0, cost: holdCosts }, curve, holdCurve, trades };
}
function runStudy(rows, config = DEFAULT_THRESHOLDS) {
  const tiers = tierStatistics(rows, config), comparison = strategyComparison(rows, config), stress = tiers.find(t => t.tier === 'STRESS');
  const warningPassed = Number.isFinite(stress.medianLeadSessions) && stress.medianLeadSessions > 0;
  return { tiers, comparison, events: drawdownEpisodes(rows, config), warningPassed,
    warningFailure: warningPassed ? null : stress.leadEvents ? `STRESS median lead is ${stress.medianLeadSessions} sessions: this rule does not warn early.` : 'No resolved STRESS lead-time events; early warning cannot be validated.' };
}
module.exports = { TIERS, median, drawdownEpisodes, forwardDrawdown, tierStatistics, allocationState, nextAllocation, rebalance, curveMetrics, strategyComparison, runStudy };
