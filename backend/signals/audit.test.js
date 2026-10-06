'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ruleFingerprint, versionEmission, normalizeEmission, seriesInputs } = require('./audit');

test('rule versions are stable and change with rules, constants or dependencies', () => {
  const version = ruleFingerprint('rule', ['fn', 'threshold=70', 'lib=1']);
  assert.equal(ruleFingerprint('rule', ['fn', 'threshold=70', 'lib=1']), version);
  for (const sources of [['fn2', 'threshold=70', 'lib=1'], ['fn', 'threshold=75', 'lib=1'], ['fn', 'threshold=70', 'lib=2']]) {
    assert.notEqual(ruleFingerprint('rule', sources), version);
  }
});

test('storage keys distinguish versions while keeping the canonical signal identity', () => {
  const row = { signal: 'breakout_20d', snap_date: '2026-10-05', symbol: 'A', source: 'reconstructed', meta: { close: 100 } };
  const first = versionEmission(row, 'v1', { threshold: 99 });
  const second = versionEmission(row, 'v2', { threshold: 98 });
  assert.notEqual(first.signal, second.signal);
  assert.equal(normalizeEmission(first).signal, row.signal);
  assert.equal(normalizeEmission(first).ruleVersion, 'v1');
  assert.deepEqual(normalizeEmission(first).inputs, { threshold: 99 });
  assert.equal(normalizeEmission(row).ruleVersion, 'legacy-unversioned');
  assert.equal(normalizeEmission(row).inputs, null);
});

test('saved input snapshots do not change when caller objects mutate', () => {
  const inputs = { candles: [{ close: 100 }] };
  const row = versionEmission({ signal: 'rule', meta: {} }, 'v1', inputs);
  inputs.candles[0].close = 200;
  assert.equal(row.meta.inputs.candles[0].close, 100);
  assert.equal(row.meta.inputSnapshot, true);
});

test('input snapshots exclude all future bars and indicator values', () => {
  const S = { candles: [{ close: 100 }, { close: 110 }, { close: 999 }], dates: ['a', 'b', 'future'], closes: [100, 110, 999], rsi14: [50, 55, 100] };
  const first = seriesInputs(S, 1);
  assert.equal(first.historyLength, 2);
  assert.deepEqual(first.windows.closes, [100, 110]);
  assert.deepEqual(first.windows.rsi14, [50, 55]);
  S.candles[2].close = 1;
  assert.equal(seriesInputs(S, 1).historyDigest, first.historyDigest);
});
