const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_THRESHOLDS: C } = require('./thresholds.ts');
const { tierStatistics, runStudy, nextAllocation, allocationState, strategyComparison, rebalance } = require('./study');
const rows = (prices, tiers = {}) => prices.map((price, i) => ({ date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10), spyOpen: price, spyClose: price, tier: tiers[i] || 'NEUTRAL' }));
const stress = r => tierStatistics(r, { ...C, outcomeWindowSessions: 3 }).find(t => t.tier === 'STRESS');
test('coincident and late STRESS readings fail the early-warning validation gate', () => {
  const r = rows([100, 95, 90, 88, 87, 100], { 2: 'STRESS', 3: 'STRESS' });
  assert.equal(stress(r).medianLeadSessions, 0);
  assert.equal(runStudy(r).warningPassed, false);
  assert.equal(stress(rows([100, 95, 90, 88, 87, 100], { 3: 'STRESS' })).medianLeadSessions, -1);
  assert.equal(runStudy(rows([100, 100, 100])).warningPassed, false);
});
test('first tier entry leads next breach; persistent state is not repeatedly credited', () => {
  const r = rows([100, 100, 95, 90, 88, 100, 101, 100], { 1: 'STRESS', 2: 'STRESS', 3: 'STRESS', 4: 'STRESS', 5: 'STRESS' });
  assert.equal(stress(r).medianLeadSessions, 2); assert.equal(stress(r).leadEvents, 1);
  const long = rows([100, 100, 100, 100, 100, 95, 90, 100], { 0: 'STRESS', 1: 'STRESS', 2: 'STRESS', 3: 'STRESS', 4: 'STRESS', 5: 'STRESS' });
  assert.equal(stress(long).leadEvents, 0);
});
test('daily false positives exclude censored readings and already incurred losses', () => {
  const r = rows([100, 90, 90, 90, 90, 90, 90], { 1: 'STRESS', 5: 'STRESS' });
  const stats = stress(r); assert.equal(stats.falsePositiveRatePct, 100); assert.equal(stats.resolvedReadings, 1); assert.equal(stats.censoredReadings, 1);
  assert.equal(stats.baseRatePct, 2 / 7 * 100);
});
test('re-entry requires consecutive lower assessments, missing resets, escalation is immediate', () => {
  let s = nextAllocation(allocationState(), 'STRESS'); assert.equal(s.exposure, .5);
  for (let i = 0; i < 9; i++) s = nextAllocation(s, 'NEUTRAL'); assert.equal(s.exposure, .5);
  s = nextAllocation(s, 'INCOMPLETE'); assert.equal(s.below, 0);
  for (let i = 0; i < 10; i++) s = nextAllocation(s, 'CAUTION'); assert.equal(s.exposure, 1);
  s = nextAllocation(s, 'CRASH MODE'); assert.equal(s.exposure, 0);
  for (let i = 0; i < 10; i++) s = nextAllocation(s, 'STRESS'); assert.equal(s.exposure, .5);
  s = nextAllocation(s, 'CRASH MODE'); assert.equal(s.exposure, 0);
});
test('signals trade at the next open, and fees/accounting affect both portfolios', () => {
  const r = rows([100, 80, 80], { 0: 'STRESS', 1: 'CRASH MODE' });
  r[0].spyOpen = 100; r[1].spyOpen = 100;
  const result = strategyComparison(r, { ...C, turnoverCostBps: 0 });
  assert.deepEqual(result.curve.map(p => p.exposure), [1, .5, 0]);
  assert.equal(result.curve[1].equity, .9); assert.equal(result.holdCurve[1].equity, .8);
  assert.equal(result.trades[0].decisionDate, r[0].date);
  const noSignals = strategyComparison(rows([100, 101, 102]));
  assert.deepEqual(noSignals.curve.map(p => p.equity), noSignals.holdCurve.map(p => p.equity));
  const a = rebalance({ shares: 0, cash: 1 }, 100, 1, .001);
  assert.ok(Math.abs(a.shares * 100 - 1 / 1.001) < 1e-12); assert.ok(Math.abs(a.cash) < 1e-12);
  const sold = rebalance(a, 100, 0, .001); assert.equal(sold.shares, 0); assert.ok(sold.cash < a.shares * 100);
});
test('allocation direction reversal inside configured window counts a whipsaw', () => {
  const result = strategyComparison(rows([100, 100, 100, 100], { 0: 'STRESS' }), { ...C, reentrySessions: 1, turnoverCostBps: 0 });
  assert.equal(result.strategy.whipsaws, 1); assert.equal(result.strategy.maxDrawdownPct, 0);
});
