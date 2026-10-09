'use strict';

const { readFileSync } = require('node:fs');

// Vercel's backend bundler treats its generated package.json CommonJS shim as
// JSON. Read the installed metadata without importing it as a JSON module.
const TECHNICAL_INDICATORS_VERSION = JSON.parse(
  readFileSync(require.resolve('technicalindicators/package.json'), 'utf8'),
).version;

module.exports = { TECHNICAL_INDICATORS_VERSION };
