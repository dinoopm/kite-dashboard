const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { compareCloses, describeDisagreement } = require('./feedAgreement');

const bars = (pairs) => pairs.map(([key, close]) => ({ key, close }));

// Full-volume feed: the official consolidated closes.
const SIP = bars([
  ['2026-07-20', 104.10],
  ['2026-07-21', 103.55],
  ['2026-07-22', 102.62],
  ['2026-07-23', 100.23],
]);

// Partial-volume feed: same sessions, its own prints. Modelled on the real
// INTC divergence that motivated this check (100.05 vs 100.23).
const IEX = bars([
  ['2026-07-20', 104.02],
  ['2026-07-21', 103.61],
  ['2026-07-22', 102.605],
  ['2026-07-23', 100.05],
]);

describe('compareCloses', () => {
  test('identical series agree', () => {
    const r = compareCloses(SIP, SIP);
    assert.equal(r.agrees, true);
    assert.equal(r.compared, 4);
    assert.deepEqual(r.divergent, []);
    assert.equal(r.worstPct, 0);
  });

  // The regression this whole module exists for.
  test('flags a partial-volume feed against the consolidated tape', () => {
    const r = compareCloses(SIP, IEX);
    assert.equal(r.agrees, false, 'iex-style divergence must be caught');
    assert.equal(r.compared, 4);
    assert.ok(r.divergent.length >= 2, `expected >=2 divergent, got ${r.divergent.length}`);
    // Worst case is the 100.23 vs 100.05 session: ~0.18%.
    assert.ok(r.worstPct > 0.001, `worst ${r.worstPct} should exceed 0.1%`);
  });

  test('pairs sessions by date, ignoring order and extra days', () => {
    const shuffled = [SIP[2], SIP[0], SIP[3], SIP[1], { date: '2026-07-24', close: 999 }];
    const r = compareCloses(shuffled, SIP);
    assert.equal(r.compared, 4, 'only the four shared keys are comparable');
    assert.equal(r.agrees, true);
  });

  // The probe that actually runs: one settled session, many symbols. Needed
  // because delayed_sip serves snapshots but not bars, so the same symbol
  // cannot be compared across sessions.
  test('pairs across symbols for a single session', () => {
    const consolidated = bars([['AAPL', 321.57], ['MSFT', 512.40], ['NVDA', 178.02], ['INTC', 100.23]]);
    const partial      = bars([['AAPL', 321.49], ['MSFT', 512.61], ['NVDA', 178.05], ['INTC', 100.05]]);
    const r = compareCloses(consolidated, partial);
    assert.equal(r.compared, 4);
    assert.equal(r.agrees, false, 'per-symbol divergence must be caught too');
  });

  test('a single divergent session is not enough to raise the alarm', () => {
    const oneOff = bars([
      ['2026-07-20', 104.10],
      ['2026-07-21', 103.55],
      ['2026-07-22', 102.62],
      ['2026-07-23', 101.90], // one bad session — a late correction, say
    ]);
    const r = compareCloses(SIP, oneOff);
    assert.equal(r.divergent.length, 1);
    assert.equal(r.agrees, true, 'one session must not trip the check');
  });

  test('reports agreement when there is nothing to compare', () => {
    assert.equal(compareCloses([], SIP).agrees, true);
    assert.equal(compareCloses(null, null).agrees, true);
    assert.equal(compareCloses(SIP, bars([['2020-01-01', 5]])).compared, 0);
  });

  test('skips malformed bars instead of counting them', () => {
    const junk = [null, { key: '2026-07-23' }, { close: 100.23 }, { key: '2026-07-23', close: 'x' }];
    const r = compareCloses(SIP, junk);
    assert.equal(r.compared, 0);
    assert.equal(r.agrees, true);
  });

  // A cent of rounding on a settled close is not a feed disagreement.
  test('tolerates sub-cent rounding', () => {
    const rounded = bars([['2026-07-22', 102.625], ['2026-07-23', 100.235]]);
    const r = compareCloses(SIP, rounded);
    assert.equal(r.agrees, true, 'half-cent rounding must not trip the check');
  });

  test('does not divide by a zero reference close', () => {
    const zeroed = bars([['2026-07-22', 0], ['2026-07-23', 0]]);
    const r = compareCloses(zeroed, SIP);
    assert.ok(Number.isFinite(r.worstPct), 'worstPct must stay finite');
  });
});

describe('describeDisagreement', () => {
  const opts = { feedA: 'sip', feedB: 'iex', symbol: 'INTC' };

  test('returns null when the feeds agree', () => {
    assert.equal(describeDisagreement(compareCloses(SIP, SIP), opts), null);
    assert.equal(describeDisagreement(null, opts), null);
  });

  test('names both feeds and the setting to change', () => {
    const d = describeDisagreement(compareCloses(SIP, IEX), opts);
    assert.ok(d, 'expected a finding');
    assert.match(d.message, /sip/);
    assert.match(d.message, /iex/);
    assert.match(d.message, /ALPACA_SNAPSHOT_FEED/);
    assert.equal(d.scope, 'INTC');
  });

  test('quotes the worst session as evidence', () => {
    const d = describeDisagreement(compareCloses(SIP, IEX), opts);
    assert.equal(d.example.key, '2026-07-23');
    assert.equal(d.example.sip, 100.23);
    assert.equal(d.example.iex, 100.05);
    assert.ok(d.worstPct > 0.1, `worstPct reported as percent, got ${d.worstPct}`);
  });
});
