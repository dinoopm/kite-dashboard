const { test } = require('node:test');
const assert = require('node:assert');
const { computeVcpScore, computeVcpContractions } = require('./vcp');

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

test('210-bar series with recent decline fails gate (SMA200 slope unverifiable)', () => {
  const candles = [];
  let price = 50;
  // 190 bars uptrend: steep rise
  for (let i = 0; i < 190; i++) {
    price *= 1.012;
    const wig = price * 0.02;
    candles.push({ open: price, high: price + wig, low: price - wig, close: price, volume: 100000 });
  }
  const peakPrice = price;
  // 20 bars gentle decline: only ~3% drop so price stays well above 50SMA
  // but SMA200(last-20) cannot be computed (need 220 bars for that)
  for (let i = 0; i < 20; i++) {
    price *= 0.9985;
    const wig = price * 0.02;
    candles.push({ open: price, high: price + wig, low: price - wig, close: price, volume: 100000 });
  }
  assert.strictEqual(candles.length, 210);
  const r = computeVcpScore(arrs(candles));
  assert.strictEqual(r.gatePassed, false, `expected gatePassed=false, got true with reason: ${r.gateFailReason}`);
  assert.strictEqual(r.vcpSetup, 'NO');
  assert.ok(r.gateFailReason.includes('200SMA'), `expected gateFailReason to mention 200SMA, got: ${r.gateFailReason}`);
});

// Three successive pullbacks of decreasing depth (~20%, ~12%, ~6%) on a zigzag.
function tighteningBase() {
  const seq = [];
  const legs = [[100, 80], [110, 97], [112, 105], [113]]; // H,L pairs, decreasing depth
  legs.forEach((leg, li) => {
    leg.forEach((target, ti) => {
      // ramp a few bars toward each target so reversals exceed the 5% threshold
      for (let k = 0; k < 4; k++) seq.push(target);
    });
  });
  return seq.map(c => ({ open: c, high: c, low: c, close: c, volume: 1000 }));
}

test('detects decreasing contractions and tightening', () => {
  const candles = tighteningBase();
  const r = computeVcpContractions({
    closes: candles.map(c => c.close), highs: candles.map(c => c.high),
    lows: candles.map(c => c.low), volumes: candles.map(c => c.volume),
  });
  assert.ok(r.contractions.length >= 2, `expected >=2 contractions, got ${r.contractions.length}`);
  const depths = r.contractions.map(c => c.depthPct);
  for (let i = 1; i < depths.length; i++) assert.ok(depths[i] <= depths[i - 1] + 0.01);
  assert.strictEqual(r.tightening, true);
  assert.match(r.verdict, /contraction/);
});

test('flat series yields no contractions', () => {
  const flat = Array.from({ length: 40 }, () => ({ open: 100, high: 100, low: 100, close: 100, volume: 1000 }));
  const r = computeVcpContractions({
    closes: flat.map(c => c.close), highs: flat.map(c => c.high),
    lows: flat.map(c => c.low), volumes: flat.map(c => c.volume),
  });
  assert.strictEqual(r.contractions.length, 0);
  assert.strictEqual(r.tightening, false);
});

const { computeScreenerRow, SCREENER_FIELDS } = require('./engine');

test('screener row exposes vcp fields', () => {
  assert.ok(SCREENER_FIELDS.some(f => f.key === 'vcpScore'));
  assert.ok(SCREENER_FIELDS.some(f => f.key === 'vcpSetup' && f.type === 'enum'));
  const candles = Array.from({ length: 220 }, (_, i) => {
    const p = 50 + i * 0.5;
    return { open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 100000, date: `2025-01-${(i % 28) + 1}` };
  });
  const row = computeScreenerRow(candles);
  assert.ok('vcpScore' in row);
  assert.ok(row.vcpSetup === 'YES' || row.vcpSetup === 'NO');
});
