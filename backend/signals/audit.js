'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');

// Changes to rules, constants, shared math or the indicator library identify
// a different model. Never retrospectively assign this fingerprint to old rows.
function ruleFingerprint(family, sources) {
  const hash = createHash('sha256');
  for (const source of sources) hash.update(String(source)).update('\0');
  return `${family}-${hash.digest('hex').slice(0, 16)}`;
}

function fileRuleVersion(family, files, extra = []) {
  return ruleFingerprint(family, [...files.map(file => readFileSync(file, 'utf8')), ...extra]);
}

function versionEmission(row, ruleVersion, inputs) {
  return {
    ...row,
    // The existing primary key includes signal, so versions can coexist even
    // when the same symbol fires on the same day. No schema change is needed.
    signal: `${row.signal}@${ruleVersion}`,
    meta: { ...row.meta, signal: row.signal, ruleVersion, inputSnapshot: Boolean(inputs), inputs: inputs ? structuredClone(inputs) : null },
  };
}

function normalizeEmission(row) {
  const meta = row.meta || {
    signal: row.canonicalSignal, ruleVersion: row.ruleVersion,
    costModel: row.costModel, inputSnapshot: row.inputSnapshot,
  };
  return {
    signal: meta.signal || row.signal,
    date: row.snap_date,
    symbol: row.symbol,
    source: row.source || 'reconstructed',
    ruleVersion: meta.ruleVersion || 'legacy-unversioned',
    inputs: meta.inputs || null,
    inputsRecorded: Boolean(meta.inputs) || meta.inputSnapshot === true || meta.inputSnapshot === 'true',
    meta,
    costModel: meta.costModel,
  };
}

function seriesInputs(S, index) {
  // Include exact causal indicator state and lookback values, rather than
  // rounded display numbers. The history digest also identifies older bars
  // that seed recursive EMA/RSI/SuperTrend state.
  const start = Math.max(0, index - 251);
  const windows = {};
  for (const [key, value] of Object.entries(S)) {
    if (Array.isArray(value)) windows[key] = value.slice(start, index + 1);
  }
  return {
    barIndex: index,
    historyLength: index + 1,
    historyDigest: ruleFingerprint('history', [JSON.stringify(S.candles.slice(0, index + 1))]),
    lookbackStart: S.dates[start],
    windows,
  };
}

module.exports = { ruleFingerprint, fileRuleVersion, versionEmission, normalizeEmission, seriesInputs };
