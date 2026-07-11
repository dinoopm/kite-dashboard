const { test } = require('node:test');
const assert = require('node:assert');
const { computeVcpScore } = require('./vcp');

// Build a synthetic textbook VCP: long prior uptrend, then a tightening base
// with declining volatility and drying volume, price coiled just under the high.
function textbookVcp() {
  const candles = [];
  let price = 50;
  // 200 bars uptrend to ~150 (ensures rising SMA200, price > SMAs)
  for (let i = 0; i < 200; i++) {
    price *= 1.005;
    const wig = price * 0.02;
    candles.push({ open: price, high: price + wig, low: price - wig, close: price, volume: 100000 });
  }
  // 40-bar base: shrinking range, drying volume, price coils near high
  const baseHigh = price;
  for (let i = 0; i < 40; i++) {
    const amp = 0.03 * (1 - i / 40);            // range shrinks toward 0 (tighter than uptrend)
    const vol = 100000 * (1 - 0.6 * i / 40);    // volume dries up more
    const c = baseHigh * (1 - 0.005 * (i / 40)); // drifts slightly down but stays above 50SMA
    candles.push({ open: c, high: c * (1 + amp), low: c * (1 - amp), close: c, volume: Math.round(vol) });
  }
  return candles;
}

function arrs(candles) {
  return {
    closes: candles.map(c => c.close),
    highs: candles.map(c => c.high),
    lows: candles.map(c => c.low),
    volumes: candles.map(c => c.volume),
  };
}

test('textbook VCP scores high and flags setup', () => {
  const r = computeVcpScore(arrs(textbookVcp()));
  assert.strictEqual(r.gatePassed, true);
  assert.ok(r.vcpScore >= 70, `expected >=70, got ${r.vcpScore}`);
  assert.strictEqual(r.vcpSetup, 'YES');
});

test('short series returns null score', () => {
  const candles = Array.from({ length: 30 }, (_, i) => ({ open: 10, high: 11, low: 9, close: 10, volume: 1000 }));
  const r = computeVcpScore(arrs(candles));
  assert.strictEqual(r.vcpScore, null);
  assert.strictEqual(r.vcpSetup, 'NO');
});

test('downtrend fails gate and is not a setup', () => {
  const candles = [];
  let price = 200;
  for (let i = 0; i < 240; i++) { price *= 0.99; candles.push({ open: price, high: price * 1.01, low: price * 0.99, close: price, volume: 100000 }); }
  const r = computeVcpScore(arrs(candles));
  assert.strictEqual(r.gatePassed, false);
  assert.strictEqual(r.vcpSetup, 'NO');
  assert.ok(r.vcpScore < 70);
});
