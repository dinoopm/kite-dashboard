export type SeverityThresholds = Readonly<{
  vixNeutralMax: number; vixCautionMax: number; vixCrashAbove: number;
  rotationSessions: number; rotationBoundaryPp: number;
  highSessions: number; correctionPct: number; rapidSessions: number; rapidDropPct: number;
  creditWideningBps: number; creditSpikeBps: number;
  divergenceDistancePct: number; divergenceWideningBps: number;
  creditEquityVixMax: number; cccLeadershipRatio: number; enableCccCrossCheck: boolean;
  staleDays: number; completedCloseHourEt: number; precisionDecimals: number;
  outcomeDrawdownPct: number; outcomeWindowSessions: number; reentrySessions: number;
  stressExposure: number; crashExposure: number; normalExposure: number;
  sessionsPerYear: number; turnoverCostBps: number; whipsawWindowSessions: number;
}>;

// Existing tier thresholds are preserved. New flags do not overwrite the tier.
// VIX values are index points; returns/drawdowns are percent, not fractions.
const DEFAULT_THRESHOLDS: SeverityThresholds = Object.freeze({
  vixNeutralMax: 15, // points: original quiet-volatility boundary (strict <).
  vixCautionMax: 20, // points: original caution ceiling (strict <).
  vixCrashAbove: 30, // points: original crash confirmation threshold (strict >).
  rotationSessions: 21, // SPY sessions: original approximately one-month comparison.
  rotationBoundaryPp: 0, // percentage points: strict relative-return leadership.
  highSessions: 252, // SPY sessions: original trailing closing-high window.
  correctionPct: 10, // percent: original correction threshold (inclusive).
  rapidSessions: 4, // SPY sessions: original less-than-five-session window.
  rapidDropPct: 10, // percent: original rapid decline threshold (strict >).
  creditWideningBps: 0, // bps: original STRESS requires any positive widening.
  creditSpikeBps: 100, // bps: original crash confirmation widening (inclusive).
  divergenceDistancePct: 3, // percent below the closing high: near-high warning candidate.
  divergenceWideningBps: 25, // bps / 21 sessions: credit weakens while equities stay near highs.
  creditEquityVixMax: 20, // VIX points: credit stress without equity confirmation, strict <.
  cccLeadershipRatio: 2, // ratio of positive CCC / broad HY widening, strict >.
  enableCccCrossCheck: true, // optional corroboration; missing CCC never changes the base tier.
  staleDays: 7, // calendar days: preserved overdue-data guard.
  completedCloseHourEt: 17, // New York hour: preserved settlement buffer for daily bars.
  precisionDecimals: 8, // arithmetic precision: preserves exact threshold boundaries.
  outcomeDrawdownPct: 10, // percent: validation event size, independent of trading rule.
  outcomeWindowSessions: 60, // SPY sessions: false-positive resolution window.
  reentrySessions: 10, // consecutive assessed sessions below the active risk tier.
  stressExposure: 0.5, // fraction of equity capital after STRESS.
  crashExposure: 0, // fraction of equity capital after crash confirmation.
  normalExposure: 1, // fraction of equity capital after the re-entry hold.
  sessionsPerYear: 252, // sessions: Sharpe annualization; CAGR uses elapsed calendar time.
  turnoverCostBps: 10, // illustrative one-way cost per unit of exposure traded, both strategies.
  whipsawWindowSessions: 10, // sessions: exposure reversal within this window counts as whipsaw.
});

function validateThresholds(config: SeverityThresholds): SeverityThresholds {
  for (const [key, value] of Object.entries(config)) {
    if (!(key in DEFAULT_THRESHOLDS)) throw new Error(`Unknown threshold: ${key}`);
    if (typeof DEFAULT_THRESHOLDS[key as keyof SeverityThresholds] === 'boolean') { if (typeof value !== 'boolean') throw new Error(`Invalid boolean threshold: ${key}`); continue; }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid threshold: ${key}`);
  }
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) if (!(key in config)) throw new Error(`Missing threshold: ${key}`);
  if (!(config.vixNeutralMax < config.vixCautionMax && config.vixCautionMax < config.vixCrashAbove)) throw new Error('VIX thresholds must be ordered');
  for (const key of ['rotationSessions', 'highSessions', 'rapidSessions', 'reentrySessions', 'outcomeWindowSessions', 'sessionsPerYear', 'whipsawWindowSessions'] as const) {
    if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error(`Invalid session window: ${key}`);
  }
  for (const key of ['correctionPct', 'rapidDropPct', 'outcomeDrawdownPct', 'divergenceDistancePct'] as const) if (config[key] >= 100) throw new Error(`Invalid percent threshold: ${key}`);
  if (config.outcomeDrawdownPct === 0 || config.turnoverCostBps >= 10000) throw new Error('Invalid outcome size or turnover cost');
  if (!(config.crashExposure <= config.stressExposure && config.stressExposure <= config.normalExposure && config.normalExposure <= 1)) throw new Error('Exposure fractions must be ordered within [0,1]');
  if (config.completedCloseHourEt > 23 || !Number.isInteger(config.completedCloseHourEt) || !Number.isInteger(config.precisionDecimals) || config.precisionDecimals > 12) throw new Error('Invalid clock/precision configuration');
  return config;
}
module.exports = { DEFAULT_THRESHOLDS, validateThresholds };
