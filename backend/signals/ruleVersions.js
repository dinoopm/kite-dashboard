'use strict';

// ─── What counts as "the same rule" for the Indian price signals ─────────────
//
// A rule version exists so results measured under different rules are never
// added together. It is a fingerprint, and what goes into it decides what
// counts as a change.
//
// It used to be the whole text of registry.js (plus the indicator files). That
// is conservative, and it was wrong in a way that cost real evidence: the
// registry also holds the labels and blocked-reasons of every OTHER signal, so
// adding an unrelated entry — a US gauge, a note on why something cannot be
// scored — changed the fingerprint of all ten price detectors. Each time, the
// recorder started a new version with only its 30-day lookback behind it, the
// earlier months were set aside as "older rules", and the badge for the
// current rules went back to a thin sample. By 2026-11-16 every price signal
// was split across three versions and none was current; three of those splits
// came from registry edits in one week that touched no detector.
//
// The fingerprint now covers what a detector's output can depend on:
//   · registry.js ABOVE the BLOCKED_SIGNALS array — the detector functions,
//     their constants, and PRICE_SIGNALS itself (names, minBars);
//   · detectAll, which decides the bars each detector is run on;
//   · the indicator, squeeze and VCP files, the indicator version, and the
//     cost model.
// Everything below that line in registry.js — blocked and recorded entries —
// is description, and editing it no longer forks anything.
//
// If the marker ever disappears the whole file is fingerprinted, as before:
// too many versions is a nuisance, pooling two different rules is a lie.

const { readFileSync } = require('fs');
const { ruleFingerprint } = require('./audit');
const { DEFAULT_COST_MODEL } = require('../signalScoring');
const { TECHNICAL_INDICATORS_VERSION } = require('./indicatorVersion');

const MARKER = 'const BLOCKED_SIGNALS = [';

/** The part of registry.js that defines the price detectors. Pure. */
function detectorSourceOf(registrySource) {
  const cut = registrySource.indexOf(MARKER);
  return cut < 0 ? registrySource : registrySource.slice(0, cut);
}

const read = (id) => readFileSync(require.resolve(id), 'utf8');
const PRICE_RULE_VERSION = ruleFingerprint('price-rules', [
  detectorSourceOf(read('./registry')),
  require('./registry').detectAll.toString(),
  read('../backtest/indicators'), read('../screener/squeeze'), read('../screener/vcp'),
  TECHNICAL_INDICATORS_VERSION, JSON.stringify(DEFAULT_COST_MODEL),
]);

module.exports = { PRICE_RULE_VERSION, detectorSourceOf };
