'use strict';

const { fileRuleVersion } = require('./audit');
const { DEFAULT_COST_MODEL } = require('../signalScoring');
const PRICE_RULE_VERSION = fileRuleVersion('price-rules', [
  require.resolve('./registry'), require.resolve('../backtest/indicators'),
  require.resolve('../screener/squeeze'), require.resolve('../screener/vcp'),
], [require('technicalindicators/package.json').version, JSON.stringify(DEFAULT_COST_MODEL)]);

module.exports = { PRICE_RULE_VERSION };
