const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_THRESHOLDS: C, validateThresholds } = require('./thresholds.ts');
const { classify, assess } = require('./classify');
const calm = { vix: 14, rotation: 1, drawdown: -2, rapidDrawdown: -1, creditChange21: -5, creditChange4: -1 };
const flag = (a, id) => a.flags.find(f => f.id === id);
test('divergence raises emphasis without changing a quiet base tier; inclusive boundaries', () => {
  const a = assess({ ...calm, drawdown: -3, creditChange21: 25 });
  assert.equal(a.state, 'NEUTRAL'); assert.equal(a.displayEmphasis, 'CAUTION');
  assert.equal(flag(a, 'divergence').triggered, true);
  for (const patch of [{ drawdown: -3.01 }, { creditChange21: 24.99 }]) assert.equal(flag(assess({ ...calm, creditChange21: 25, ...patch }), 'divergence').triggered, false);
  assert.equal(classify({ ...calm, creditChange21: 25 }, { ...C, divergenceWideningBps: 100 }), 'NEUTRAL');
  assert.equal(flag(assess({ ...calm, creditChange21: 25 }, { ...C, divergenceWideningBps: 100 }), 'divergence').triggered, false);
});
test('cross-check requires positive credit widening and calm VIX; CCC is optional and strict', () => {
  const m = { ...calm, creditChange21: 25, cccChange21: 50 };
  assert.equal(flag(assess(m), 'creditWithoutEquity').triggered, true);
  assert.equal(flag(assess({ ...m, vix: 20 }), 'creditWithoutEquity').triggered, false);
  assert.equal(flag(assess(m), 'cccLeadership').triggered, false);
  assert.equal(flag(assess({ ...m, cccChange21: 50.01 }), 'cccLeadership').triggered, true);
  assert.equal(flag(assess({ ...m, cccChange21: null }), 'cccLeadership').triggered, null);
  assert.equal(flag(assess(m, { ...C, enableCccCrossCheck: false }), 'cccLeadership').triggered, null);
  assert.equal(classify({ ...m, cccChange21: null }), 'NEUTRAL');
});
test('typed configuration rejects invalid windows, booleans, exposures, and missing thresholds', () => {
  for (const patch of [{ rotationSessions: 0 }, { highSessions: 2.1 }, { enableCccCrossCheck: 1 }, { correctionPct: true }, { stressExposure: 2 }, { vixNeutralMax: 21 }, { rotaionSessions: 21 }, { turnoverCostBps: 10000 }, { outcomeDrawdownPct: 0 }]) assert.throws(() => validateThresholds({ ...C, ...patch }));
  const partial = { ...C }; delete partial.rapidSessions; assert.throws(() => validateThresholds(partial));
  assert.equal(validateThresholds(C), C);
});
test('base classification is unchanged across all threshold boundaries and a deterministic grid', () => {
  const oldRule = m => m.vix > 30 && m.rapidDrawdown < -10 && m.creditChange4 >= 100 ? 'CRASH MODE' : m.vix >= 20 && m.vix <= 30 && m.drawdown <= -10 && m.creditChange21 > 0 ? 'STRESS' : m.vix >= 15 && m.vix < 20 && m.rotation < 0 ? 'CAUTION' : m.vix < 15 && m.rotation > 0 ? 'NEUTRAL' : 'MIXED';
  for (const vix of [14.99, 15, 19.99, 20, 30, 30.01]) for (const rotation of [-1, 0, 1]) for (const drawdown of [-10.01, -10, -9.99]) for (const creditChange21 of [-1, 0, 1]) for (const rapidDrawdown of [-10.01, -10]) for (const creditChange4 of [99.99, 100]) {
    const m = { vix, rotation, drawdown, creditChange21, rapidDrawdown, creditChange4 }; assert.equal(classify(m), oldRule(m));
  }
  assert.equal(assess(calm).tiers.find(t => t.id === 'CRASH MODE').role, 'Confirmation');
});
