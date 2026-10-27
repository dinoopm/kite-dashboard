const { DEFAULT_THRESHOLDS } = require('./thresholds.ts');
const finite = Number.isFinite;
const check = (value, test) => finite(value) ? test(value) : null;
const all = checks => checks.some(c => c.pass === false) ? false : checks.some(c => c.pass == null) ? null : true;
function tiersFor(m, c) {
  return [
    { id: 'NEUTRAL', role: 'Context', description: 'Quiet volatility and stocks beating bonds', explanation: 'Describes the current backdrop. It does not predict a positive stock return.', checks: [
      { label: `VIX < ${c.vixNeutralMax}`, pass: check(m.vix, v => v < c.vixNeutralMax) },
      { label: `SPY return > TLT return over ${c.rotationSessions} sessions`, pass: check(m.rotation, v => v > c.rotationBoundaryPp) },
    ] },
    { id: 'CAUTION', role: 'Watch', description: 'Moderate volatility and bonds beating stocks', explanation: 'A watch state. Credit divergence is a separate early-warning candidate; its predictive value must be measured.', checks: [
      { label: `${c.vixNeutralMax} ≤ VIX < ${c.vixCautionMax}`, pass: check(m.vix, v => v >= c.vixNeutralMax && v < c.vixCautionMax) },
      { label: `TLT return > SPY return over ${c.rotationSessions} sessions`, pass: check(m.rotation, v => v < c.rotationBoundaryPp) },
    ] },
    { id: 'STRESS', role: 'Escalation', description: 'Higher volatility, a correction and widening credit spreads', explanation: `Escalation during an existing correction. Because drawdown is already at least ${c.correctionPct}%, this is not inherently an early warning.`, checks: [
      { label: `${c.vixCautionMax} ≤ VIX ≤ ${c.vixCrashAbove}`, pass: check(m.vix, v => v >= c.vixCautionMax && v <= c.vixCrashAbove) },
      { label: `SPY ≥ ${c.correctionPct}% below its ${c.highSessions}-session closing high`, pass: check(m.drawdown, v => v <= -c.correctionPct) },
      { label: `HY OAS wider by > ${c.creditWideningBps} bps over ${c.rotationSessions} sessions`, pass: check(m.creditChange21, v => v > c.creditWideningBps) },
    ] },
    { id: 'CRASH MODE', role: 'Confirmation', description: 'Crash confirmation — all three coincident checks pass', explanation: 'Confirms an ongoing crash; it is not an early-warning forecast. All three conditions are required.', checks: [
      { label: `VIX > ${c.vixCrashAbove}`, pass: check(m.vix, v => v > c.vixCrashAbove) },
      { label: `SPY decline > ${c.rapidDropPct}% from a closing peak within ${c.rapidSessions} sessions`, pass: check(m.rapidDrawdown, v => v < -c.rapidDropPct) },
      { label: `HY OAS wider by ≥ ${c.creditSpikeBps} bps in ${c.rapidSessions} sessions`, pass: check(m.creditChange4, v => v >= c.creditSpikeBps) },
    ] },
  ];
}
function flagsFor(m, c) {
  const flag = (id, signal, label, role, checks) => ({ id, signal, label, role, checks, triggered: all(checks) });
  return [
    flag('divergence', 'us_credit_divergence', 'Credit divergence', 'Early-warning candidate', [
      { label: `SPY within ${c.divergenceDistancePct}% of its ${c.highSessions}-session closing high`, pass: check(m.drawdown, v => v >= -c.divergenceDistancePct && v <= 0) },
      { label: `HY OAS wider by ≥ ${c.divergenceWideningBps} bps over ${c.rotationSessions} sessions`, pass: check(m.creditChange21, v => v >= c.divergenceWideningBps) },
    ]),
    flag('creditWithoutEquity', 'us_credit_without_equity', 'Credit stress without equity confirmation (watch, may be sector-specific)', 'Cross-check', [
      { label: `HY OAS widening over ${c.rotationSessions} sessions`, pass: check(m.creditChange21, v => v > c.creditWideningBps) },
      { label: `VIX < ${c.creditEquityVixMax}`, pass: check(m.vix, v => v < c.creditEquityVixMax) },
    ]),
    flag('cccLeadership', 'us_ccc_leadership', 'CCC-rated credit leads widening', 'Optional cross-check', [
      { label: 'Broad HY OAS is widening', pass: check(m.creditChange21, v => v > c.creditWideningBps) },
      { label: `CCC widening > ${c.cccLeadershipRatio}× broad HY widening over ${c.rotationSessions} sessions`, pass: !c.enableCccCrossCheck || !finite(m.cccChange21) || !finite(m.creditChange21) ? null : m.creditChange21 > 0 && m.cccChange21 > c.cccLeadershipRatio * m.creditChange21 },
    ]),
  ];
}
function classify(inputs, config = DEFAULT_THRESHOLDS) {
  if (inputs.stale || ['vix', 'rotation', 'drawdown', 'rapidDrawdown', 'creditChange21', 'creditChange4'].some(key => !finite(inputs[key]))) return 'INCOMPLETE';
  return [...tiersFor(inputs, config)].reverse().find(tier => tier.checks.every(c => c.pass === true))?.id || 'MIXED';
}
function assess(inputs, config = DEFAULT_THRESHOLDS) {
  const state = classify(inputs, config), tiers = tiersFor(inputs, config), flags = flagsFor(inputs, config);
  return { state, tiers, flags, missing: ['vix', 'rotation', 'drawdown', 'rapidDrawdown', 'creditChange21', 'creditChange4'].filter(key => !finite(inputs[key])),
    reason: state === 'INCOMPLETE' ? (inputs.stale ? 'The common observation date is overdue.' : 'One or more required inputs are unavailable.') : tiers.find(t => t.id === state)?.description || 'No tier has every check confirmed. Mixed conditions do not count as Neutral.',
    displayEmphasis: flags.find(f => f.id === 'divergence').triggered === true ? (state === 'STRESS' || state === 'CRASH MODE' ? state : 'CAUTION') : state,
  };
}
module.exports = { classify, assess, tiersFor, flagsFor };
