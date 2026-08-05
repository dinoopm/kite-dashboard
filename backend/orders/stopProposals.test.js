const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { computeStopProposal, trailingStop, RULE, LIMITS } = require('./stopProposals');

const bar = (i, close, low = close * 0.99) => ({
  date: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`,
  high: close * 1.01, low, close,
});
const flat = (n, price) => Array.from({ length: n }, (_, i) => bar(i, price));
const holding = (over = {}) => ({
  symbol: 'CGPOWER', exchange: 'BSE', instrument_token: 128023812,
  quantity: 950, last_price: 880, average_price: 695.76, ...over,
});

describe('trailingStop', () => {
  test('produces a level below spot for a steady series', () => {
    const lvl = trailingStop(flat(80, 100));
    assert.ok(lvl != null && lvl < 100, `expected a level under 100, got ${lvl}`);
  });

  // The property that makes it protective rather than decorative.
  test('ratchets up and never loosens as price falls back', () => {
    const rising = Array.from({ length: 80 }, (_, i) => bar(i, 100 + i));
    const thenFalling = [...rising, ...Array.from({ length: 20 }, (_, i) => bar(80 + i, 180 - i * 4))];
    const atPeak = trailingStop(rising);
    const afterDrop = trailingStop(thenFalling);
    assert.ok(afterDrop >= atPeak, `stop fell from ${atPeak} to ${afterDrop}`);
  });

  test('refuses to guess without enough history', () => {
    assert.equal(trailingStop(flat(10, 100)), null);
    assert.equal(trailingStop([]), null);
    assert.equal(trailingStop(null), null);
  });
});

describe('computeStopProposal', () => {
  test('proposes a stop below spot with the loss in rupees', () => {
    const p = computeStopProposal(holding(), flat(80, 880));
    assert.equal(p.status, 'proposed');
    assert.ok(p.trigger_price < 880);
    assert.ok(p.worst_case_loss < 0, 'the worst case is a loss, so it is negative');
    // 950 shares from spot to trigger.
    assert.equal(p.worst_case_loss, +((p.trigger_price - 880) * 950).toFixed(2));
    assert.equal(p.rule, RULE.name);
  });

  // Carries the venue through untouched — the CGPOWER lesson.
  test('keeps the holding exchange and token rather than assuming NSE', () => {
    const p = computeStopProposal(holding(), flat(80, 880));
    assert.equal(p.exchange, 'BSE');
    assert.equal(p.instrument_token, 128023812);
  });

  test('rejects a position with no quantity', () => {
    const p = computeStopProposal(holding({ quantity: 0 }), flat(80, 880));
    assert.equal(p.status, 'rejected');
    assert.match(p.reject_reason, /no quantity/);
  });

  test('rejects when there is not enough history to compute a trail', () => {
    const p = computeStopProposal(holding(), flat(5, 880));
    assert.equal(p.status, 'rejected');
    assert.match(p.reject_reason, /bars of history/);
  });

  test('rejects when bars are missing entirely', () => {
    const p = computeStopProposal(holding(), null);
    assert.equal(p.status, 'rejected');
  });

  // The dangerous case: a position already below its own trail. Placing this
  // would be a market sell dressed as a stop.
  // The live form of the NEWGEN pattern: the position fell through its stop
  // some time ago. This is a finding, not a failure, so it gets its own status
  // rather than being filed next to 'no quantity held'.
  test('reports a position already below its trail as breached, not rejected', () => {
    const rising = Array.from({ length: 80 }, (_, i) => bar(i, 100 + i * 2));
    const p = computeStopProposal(holding({ last_price: 50, quantity: 10 }), rising);
    assert.equal(p.status, 'breached');
    assert.ok(p.breached_level > 50, 'carries the level it fell through');
    assert.ok(p.below_trail_pct > 0, 'and how far below it now sits');
    assert.equal(p.trigger_price, null, 'proposes no order — that would be a market sell');
    assert.equal(p.worst_case_loss, null);
  });

  test('a breach is never counted as a computation failure', () => {
    const rising = Array.from({ length: 80 }, (_, i) => bar(i, 100 + i * 2));
    const p = computeStopProposal(holding({ last_price: 50, quantity: 10 }), rising);
    assert.notEqual(p.status, 'rejected');
  });

  test('rejects a stop implying a fall beyond the cap', () => {
    const p = computeStopProposal(holding({ last_price: 880 }), flat(80, 880),
      { limits: { ...LIMITS, maxLossPct: 0.6 } });
    assert.equal(p.status, 'rejected');
    assert.match(p.reject_reason, /beyond the 0.6% cap/);
  });

  test('rejects a stop sitting inside normal noise', () => {
    const p = computeStopProposal(holding(), flat(80, 880),
      { limits: { ...LIMITS, minDistancePct: 99 } });
    assert.equal(p.status, 'rejected');
    assert.match(p.reject_reason, /inside normal noise/);
  });

  // A rejection is still a record. "Why was there no stop on that position?"
  // is the question that matters after a loss.
  test('a rejection still carries the identity of what was skipped', () => {
    const p = computeStopProposal(holding({ quantity: 0 }), flat(80, 880));
    assert.equal(p.symbol, 'CGPOWER');
    assert.equal(p.exchange, 'BSE');
    assert.equal(p.rule, RULE.name);
    assert.equal(p.status, 'rejected');
  });
});
