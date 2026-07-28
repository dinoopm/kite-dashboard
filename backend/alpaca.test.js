const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TNX_RANGES, TNX_DEFAULT_RANGE, tnxRangeConfig } = require('./alpaca');

describe('treasury-10y ranges', () => {
  test('every range asks for at least as much history as the one below it', () => {
    const order = ['1M', '3M', '6M', '1Y', '2Y', '3Y', '4Y', '5Y', '10Y'];
    for (let i = 1; i < order.length; i++) {
      assert.ok(
        TNX_RANGES[order[i]].days > TNX_RANGES[order[i - 1]].days,
        `${order[i]} must look back further than ${order[i - 1]}`,
      );
    }
  });

  test('switches to weekly bars only past the point daily gets too dense', () => {
    for (const r of ['1M', '3M', '6M', '1Y', '2Y']) {
      assert.equal(TNX_RANGES[r].interval, '1d', `${r} should still be daily`);
    }
    for (const r of ['3Y', '4Y', '5Y', '10Y']) {
      assert.equal(TNX_RANGES[r].interval, '1wk', `${r} should be weekly`);
    }
  });

  // An unknown range silently serves the default window while the response
  // still echoes the range that was asked for — six months of data captioned
  // "over 3Y". That is why the coverage test below exists.
  test('an unknown range falls back to the default window', () => {
    assert.deepEqual(tnxRangeConfig('7Y'), TNX_RANGES[TNX_DEFAULT_RANGE]);
    assert.deepEqual(tnxRangeConfig(undefined), TNX_RANGES[TNX_DEFAULT_RANGE]);
  });

  test('every range button the chart offers has a backend entry', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../frontend/src/components/TreasuryChart.jsx'), 'utf8');
    const m = src.match(/const RANGES = \[([^\]]+)\]/);
    assert.ok(m, 'could not find the RANGES list in TreasuryChart.jsx');
    const buttons = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    assert.ok(buttons.length >= 9, `expected the full range row, got ${buttons.join(',')}`);
    for (const b of buttons) {
      assert.ok(TNX_RANGES[b], `chart offers "${b}" but the backend has no window for it`);
    }
  });
});
