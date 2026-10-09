'use strict';

const { fileRuleVersion } = require('./audit');
const { DEFAULT_COST_MODEL } = require('../signalScoring');
const { TECHNICAL_INDICATORS_VERSION } = require('./indicatorVersion');
const PRICE_RULE_VERSION = fileRuleVersion('price-rules', [
  require.resolve('./registry'), require.resolve('../backtest/indicators'),
  require.resolve('../screener/squeeze'), require.resolve('../screener/vcp'),
], [TECHNICAL_INDICATORS_VERSION, JSON.stringify(DEFAULT_COST_MODEL)]);

module.exports = { PRICE_RULE_VERSION };
