#!/usr/bin/env node
// Offline entry point. Never imported by the UI request path.
const fs = require('node:fs/promises');
const path = require('node:path');
const { RULES, RULE_VERSION, completedCutoff } = require('../usRiskSeverity');
const { reconstruct, coverageFor, EPISODES } = require('./replay');
const { runStudy, TIERS } = require('./study');
const { configFingerprint, DEFAULT_REPORT } = require('./validation');
const { probeHistoricalCredit } = require('./data');
const { validateThresholds } = require('./thresholds.ts');
const { fileRuleVersion } = require('../signals/audit');
const STUDY_VERSION = fileRuleVersion('severity-study', [__filename, require.resolve('./study'), require.resolve('./replay')]);
const DEFAULT_OUT = path.join(__dirname, '../reports/us-risk-severity');
const cell = value => value == null ? '' : `"${String(value).replace(/"/g, '""')}"`;
const csv = (columns, rows) => [columns.join(','), ...rows.map(row => columns.map(column => cell(row[column])).join(','))].join('\n') + '\n';
const fmt = value => Number.isFinite(value) ? value.toFixed(2) : 'Unavailable';
async function writeReport(result, out, { latestPath = DEFAULT_REPORT } = {}) {
  await fs.mkdir(out, { recursive: true });
  const tierRows = (result.tiers || TIERS.map(tier => ({ tier }))).map(({ leads, ...row }) => row);
  const strategies = result.comparison ? [result.comparison.strategy, result.comparison.buyHold] : [{ name: 'Severity de-risking' }, { name: 'Buy-and-hold SPY' }];
  const episodes = result.coverage?.episodes || EPISODES.map(([name, from, to]) => ({ name, from, to, sessions: 0, missing: null, covered: false }));
  const daily = (result.rows || []).map(row => ({ date: row.date, basisDate: row.basisDate, tier: row.tier, spyClose: row.spyClose, ...row.metrics, ...row.flags, vintages: JSON.stringify(row.vintages) }));
  await Promise.all([
    fs.writeFile(path.join(out, 'tiers.csv'), csv(['tier', 'days', 'baseRatePct', 'medianLeadSessions', 'medianLeadCalendarDays', 'leadEvents', 'resolvedReadings', 'censoredReadings', 'falsePositives', 'falsePositiveRatePct'], tierRows)),
    fs.writeFile(path.join(out, 'strategies.csv'), csv(['name', 'cagrPct', 'maxDrawdownPct', 'sharpe', 'whipsaws', 'allocationChanges', 'cost'], strategies)),
    fs.writeFile(path.join(out, 'coverage.csv'), csv(['name', 'from', 'to', 'sessions', 'missing', 'covered'], episodes)),
    fs.writeFile(path.join(out, 'classifications.csv'), csv(['date', 'basisDate', 'tier', 'spyClose', 'vix', 'rotation', 'drawdown', 'rapidDrawdown', 'creditChange21', 'creditChange4', 'cccChange21', 'divergence', 'creditWithoutEquity', 'cccLeadership', 'vintages'], daily)),
    fs.writeFile(path.join(out, 'lead-times.csv'), csv(['tier', 'reading', 'breach', 'sessions', 'days'], (result.tiers || []).flatMap(row => (row.leads || []).map(lead => ({ tier: row.tier, ...lead }))))),
    fs.writeFile(path.join(out, 'equity.csv'), csv(['date', 'strategy', 'buyHold', 'exposure'], (result.comparison?.curve || []).map((row, i) => ({ date: row.date, strategy: row.equity, buyHold: result.comparison.holdCurve[i].equity, exposure: row.exposure })))),
    fs.writeFile(path.join(out, 'trades.csv'), csv(['date', 'decisionDate', 'from', 'to'], result.comparison?.trades || [])),
  ]);
  const c = result.config;
  const report = [
    '# Market risk severity — offline validation', '',
    `Status: **${result.status}**. Requested ${result.start} → ${result.end}.`, '',
    result.blocker || (result.status === 'failed-warning' ? result.warningFailure : 'Completed using the supplied point-in-time archive.'), '',
    `Rule: ${result.ruleVersion}. Study: ${result.studyVersion}.`, '',
    `| Tier | Days (%) | Median lead (sessions / calendar days) | False positives (${c.outcomeWindowSessions} sessions) | Lead events / resolved readings |`,
    '|---|---:|---:|---:|---:|',
    ...tierRows.map(row => `| ${row.tier} | ${fmt(row.baseRatePct)} | ${fmt(row.medianLeadSessions)} / ${fmt(row.medianLeadCalendarDays)} | ${fmt(row.falsePositiveRatePct)}% | ${row.leadEvents ?? '—'} / ${row.resolvedReadings ?? '—'} |`), '',
    '| Strategy | CAGR (%) | Max drawdown (%) | Sharpe | Whipsaws |', '|---|---:|---:|---:|---:|',
    ...strategies.map(row => `| ${row.name} | ${fmt(row.cagrPct)} | ${fmt(row.maxDrawdownPct)} | ${fmt(row.sharpe)} | ${row.whipsaws ?? '—'} |`), '',
    'Coverage: ' + episodes.map(e => `${e.name}: ${e.covered ? 'covered' : 'MISSING'}`).join('; ') + '.', '',
    result.diagnostic ? `Source diagnostic: current HY history ${result.diagnostic.first || 'unavailable'} → ${result.diagnostic.last || 'unavailable'}. Current observations are not historical vintages.` : '', '',
    '## Definitions and limits', '',
    '- The base tier thresholds are unchanged; divergence and cross-check flags do not alter the strategy’s tier or exposure.',
    '- Each decision uses only vintage observations available at that exchange-session close. Every input in an assessment uses the same observation date, which may be earlier than the decision date. No missing session is compressed out of a lookback. Archive provenance and the supplied exchange calendar are required.',
    `- Drawdown events are non-overlapping ${c.outcomeDrawdownPct}% directional-change cycles from a local closing peak. A ${c.outcomeDrawdownPct}% rebound from the trough starts a new cycle; this includes corrections during long recoveries. Lead time is measured from the first tier entry associated with an event to its first breach. Late entries in an active drawdown retain zero/negative lead times. Persistent states are not repeatedly credited with leading later events.`,
    `- False positives are daily tier readings followed by no new ${c.outcomeDrawdownPct}% peak-to-trough decline in the next ${c.outcomeWindowSessions} SPY sessions, starting from that reading’s close. Existing losses before the reading do not count as a new future decline. The last ${c.outcomeWindowSessions} sessions are right-censored. Daily readings overlap and are not independent trials. Lead-time event counts and daily false-positive denominators are different units.`,
    `- Exposure is set from the prior closing assessment and executed at the next session’s open. STRESS targets ${c.stressExposure * 100}% equities, CRASH MODE ${c.crashExposure * 100}%; re-entry requires ${c.reentrySessions} consecutive assessed sessions below the held risk tier. INCOMPLETE resets the recovery streak and preserves exposure. MIXED is below STRESS under the supplied rule.`,
    `- The strategy rebalances daily at the open to its target equity fraction, including drift turnover. Both portfolios pay ${c.turnoverCostBps} bps one-way turnover cost. SPY raw price returns exclude dividends; cash earns 0%, Sharpe uses a 0% risk-free rate and ${c.sessionsPerYear} sessions/year. No leverage, tax or execution-capacity model is assumed.`,
    `- A whipsaw is a reversal in target-allocation direction within ${c.whipsawWindowSessions} sessions. CAGR uses elapsed calendar time; max drawdown includes initial capital. Configured overrides are retained in latest.json.`,
    '- A complete study exits nonzero when STRESS has zero/negative median lead, or no resolved lead-time events. Data/provenance/coverage failures also exit nonzero. Incomplete runs never replace the unvalidated UI badge with measured performance.',
    '- No threshold optimization or out-of-sample holdout was performed by this fixed-rule study. Even positive historical lead time would not establish a reliable trading edge.', '',
  ].filter(line => line !== null).join('\n');
  await fs.writeFile(path.join(out, 'report.md'), report);
  const summary = { ...result }; delete summary.rows; delete summary.comparison; delete summary.events;
  await fs.writeFile(path.join(out, 'latest.json'), JSON.stringify(summary, null, 2) + '\n');
  await fs.mkdir(path.dirname(latestPath), { recursive: true });
  const temp = `${latestPath}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(summary, null, 2) + '\n'); await fs.rename(temp, latestPath);
}
function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (['--input', '--out', '--config', '--start', '--end'].includes(args[i])) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing value for ${args[i]}`);
      options[args[i].slice(2)] = args[++i];
    } else if (args[i] === '--download') options.download = true;
    else throw Error(`Unknown argument: ${args[i]}`);
  }
  return options;
}
async function main(args = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(args);
  const config = options.config ? validateThresholds({ ...RULES, ...JSON.parse(await fs.readFile(options.config, 'utf8')) }) : RULES;
  const start = options.start || '2007-01-01', end = options.end || completedCutoff(new Date(), config), out = options.out || DEFAULT_OUT;
  let result = { start, end, ruleVersion: RULE_VERSION, studyVersion: STUDY_VERSION, config, configFingerprint: configFingerprint(config), generatedAt: new Date().toISOString(), provenance: 'unavailable', status: 'blocked' };
  try {
    if (!options.input) {
      result.diagnostic = await (dependencies.probe || probeHistoricalCredit)({ start: '2005-01-01', end });
      throw Error(`${result.diagnostic.error} Supply --input with a documented, timestamped archive covering the full study and warm-up period. No current-history substitute was used.`);
    }
    const dataset = JSON.parse(await fs.readFile(options.input, 'utf8'));
    const replay = reconstruct(dataset, config, { start, end });
    result = { ...result, provenance: replay.provenance, rows: replay.rows, archiveProvenance: dataset.provenance, coverage: coverageFor(replay.rows, { start, end }) };
    if (!result.coverage.complete) throw Error('Point-in-time coverage is incomplete for the full 2007–present study or one or more required crisis windows. No performance statistics are published from this partial sample.');
    const study = runStudy(replay.rows, config);
    result = { ...result, ...study, status: study.warningPassed ? 'passed' : 'failed-warning' };
  } catch (error) { result.status = 'blocked'; result.blocker = error.message; }
  await writeReport(result, out, { latestPath: dependencies.latestPath || DEFAULT_REPORT });
  const code = result.status === 'passed' ? 0 : result.status === 'failed-warning' ? 1 : 2;
  (code ? console.error : console.log)(`${code ? 'BACKTEST FAILED' : 'BACKTEST COMPLETE'}: ${result.blocker || result.warningFailure || 'positive median STRESS lead'}\nReport: ${path.join(out, 'report.md')}`);
  return { code, result, out };
}
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });
  main().then(({ code }) => { process.exitCode = code; }).catch(error => { console.error(`BACKTEST FAILED: ${error.message}`); process.exitCode = 2; });
}
module.exports = { main, parseArgs, writeReport, csv, STUDY_VERSION };
