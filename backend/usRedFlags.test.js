// backend/usRedFlags.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { barFlags } = require('./usRedFlags');

const mk = (closes, volumes = null) => closes.map((c, i) => ({
  date: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
  open: c, high: c * 1.01, low: c * 0.99, close: c, volume: volumes ? volumes[i] : 1e6,
}));

describe('barFlags', () => {
  test('flags a pump-and-fade as red', () => {
    const c = [];
    for (let i = 0; i < 20; i++) c.push(10);
    for (let i = 1; i <= 8; i++) c.push(10 + i * 1);     // +80% ramp
    for (let i = 1; i <= 6; i++) c.push(18 - i * 1);     // −33% off the peak
    const flags = barFlags(mk(c));
    assert.ok(flags.some(f => f.id === 'pump-fade' && f.severity === 'red'));
  });

  test('a quiet, liquid, trending stock has no flags', () => {
    const c = Array.from({ length: 40 }, (_, i) => 100 + i * 0.2);
    assert.deepEqual(barFlags(mk(c)), []);
  });

  test('thin liquidity is amber, never red', () => {
    const c = Array.from({ length: 40 }, () => 2);
    const flags = barFlags(mk(c, c.map(() => 1000)));
    const thin = flags.find(f => f.id === 'thin-liquidity');
    assert.ok(thin);
    assert.equal(thin.severity, 'amber');
  });

  test('says nothing on too little history', () => {
    assert.deepEqual(barFlags(mk([1, 2, 3])), []);
  });
});
