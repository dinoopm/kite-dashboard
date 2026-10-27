const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const DEFAULT_REPORT = path.join(__dirname, '../data/us-risk-severity/validation/latest.json');
function configFingerprint(config) {
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
}
async function validationBadge(fallback, ruleVersion, config, reportPath = process.env.US_RISK_VALIDATION_FILE || DEFAULT_REPORT) {
  let result;
  try { result = JSON.parse(await fs.readFile(reportPath, 'utf8')); } catch { return fallback; }
  if (result.ruleVersion !== ruleVersion || result.configFingerprint !== configFingerprint(config)) return fallback;
  if (!result.coverage?.complete || result.provenance !== 'point-in-time' || !['passed', 'failed-warning'].includes(result.status)) {
    return { ...fallback, headline: { ...fallback.headline, detail: `${fallback.headline.detail}\n\nLast offline attempt: ${result.blocker || 'Incomplete point-in-time coverage.'}` } };
  }
  const stress = result.tiers?.find(row => row.tier === 'STRESS');
  if (!stress || !Number.isFinite(stress.medianLeadSessions) || !Number.isFinite(stress.falsePositiveRatePct)) return fallback;
  const lead = `${stress.medianLeadSessions > 0 ? '+' : ''}${stress.medianLeadSessions.toFixed(1)}`;
  return { ...fallback, headline: {
    state: result.status === 'failed-warning' ? 'negative' : 'thin',
    text: `STRESS lead ${lead} sessions · false positives ${stress.falsePositiveRatePct.toFixed(1)}%`,
    detail: `Point-in-time offline study, ${result.start} to ${result.end}. ${stress.leadEvents} drawdown episodes and ${stress.resolvedReadings} resolved daily STRESS readings. ${result.status === 'failed-warning' ? 'Fails the early-warning check: median lead is zero or negative.' : 'A measured historical result, not a guarantee. Thresholds were not optimized in this run.'} Daily observations overlap. Rule version: ${ruleVersion}.`,
  } };
}
module.exports = { DEFAULT_REPORT, configFingerprint, validationBadge };
