const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { financialRead, describeFinancial, scale, THRESHOLDS } = require('./financial');

// Live values on 2026-08-12: conditions well on the easy side of average.
const LIVE = {
  financialConditions: { latest: -0.549, changePp: -0.02 },
  creditSpread: { latest: 2.72, changePp: -0.15 },
  yieldCurve: { latest: 0.48, changePp: 0.06 },
};

describe('scale', () => {
  test('maps the loose end to -1 and the tight end to +1', () => {
    assert.equal(scale(-1, -1, 1), -1);
    assert.equal(scale(1, -1, 1), 1);
  });

  test('clamps rather than running away past the ends', () => {
    assert.equal(scale(-5, -1, 1), -1);
    assert.equal(scale(5, -1, 1), 1);
  });

  test('returns null for a missing reading, never a neutral zero', () => {
    assert.equal(scale(null, -1, 1), null);
  });
});

describe('financialRead', () => {
  const r = financialRead(LIVE);

  test('reads the live backdrop as loose', () => {
    assert.equal(r.state, 'loose');
    assert.ok(r.score < -0.25, `score was ${r.score}`);
    assert.equal(r.inputsUsed, 2);
  });

  test('scores NFCI against its own zero, which the index defines', () => {
    // The one threshold here that nobody chose: NFCI is normalised so 0 is the
    // historical average. Loose-versus-tight needs no invented cut-off.
    assert.equal(THRESHOLDS.nfci.looseAt, -1.0);
    assert.equal(THRESHOLDS.nfci.tightAt, 1.0);
    assert.ok(r.components.nfci.score < 0, 'a negative NFCI must read as looser than average');
    // The gauge has to MOVE. A ±0.25 band clamped at the live value and sat at
    // exactly -1.000 regardless of what the data did.
    assert.ok(r.score > -1, `score saturated at ${r.score} — the band is too narrow to be informative`);
    assert.ok(Math.abs(r.components.nfci.score - -0.549) < 0.01, 'a z-score index should map proportionally');
  });

  test('reads wide spreads as stressed and tight spreads as easy', () => {
    const stressed = financialRead({ ...LIVE, creditSpread: { latest: 8.0 } });
    assert.equal(stressed.components.creditSpread.score, 1);
    const easy = financialRead({ ...LIVE, creditSpread: { latest: 3.5 } });
    assert.ok(easy.components.creditSpread.score > -1, 'ordinary spreads must not clamp');
    assert.ok(stressed.score > r.score, 'widening credit must move the read toward tight');
  });

  // The whole reason this module exists separately.
  test('produces nothing that could reach the composite', () => {
    assert.equal(r.weight, undefined);
    assert.equal(r.contribution, undefined);
    assert.equal(r.regime, undefined);
    assert.equal(r.bias, undefined);
  });

  test('carries the yield curve but never scores it', () => {
    assert.equal(r.components.yieldCurve.scored, false);
    assert.equal(r.components.yieldCurve.inverted, false);
    assert.equal(financialRead({ ...LIVE, yieldCurve: { latest: -0.35 } }).components.yieldCurve.inverted, true);
    // Two inputs, not three — the curve must not quietly become a third.
    assert.equal(r.inputsTotal, 2);
  });

  test('drops a missing input rather than scoring it average', () => {
    const partial = financialRead({ financialConditions: LIVE.financialConditions });
    assert.equal(partial.inputsUsed, 1);
    assert.equal(partial.components.creditSpread, null);
    assert.ok(partial.score != null);
  });

  test('says unknown when nothing is available', () => {
    const none = financialRead({});
    assert.equal(none.score, null);
    assert.equal(none.state, 'unknown');
    assert.equal(none.inputsUsed, 0);
  });
});

describe('describeFinancial', () => {
  const text = describeFinancial(financialRead(LIVE));

  test('names both figures and which side of average they sit', () => {
    assert.match(text, /-0\.55|-0\.549/);
    assert.match(text, /2\.72pp/);
    assert.match(text, /easier than average/);
  });

  // A loose reading sitting under an inflation panel invites being read as a
  // rate call. It has to disclaim itself in the same sentence.
  test('states that it does not feed the macro score', () => {
    assert.match(text, /does not feed the macro score/);
  });

  test('reports the curve as context, not as a signal', () => {
    assert.match(text, /context rather than scored/);
  });

  test('never asserts a central-bank action', () => {
    const lower = text.toLowerCase();
    for (const b of ['will hike', 'will cut', 'the fed will', 'recession', 'forecast']) {
      assert.ok(!lower.includes(b), `contains "${b}"`);
    }
  });

  test('degrades to a plain statement with no data', () => {
    assert.match(describeFinancial(financialRead({})), /No current reading/);
  });
});
