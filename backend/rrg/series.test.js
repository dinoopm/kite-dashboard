const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { rrgSeries, resampleToWeekly, quadrantOf, weekComplete, fridayKey } = require('./series');

// n business days from a Monday, close following f(i).
function daily(n, f, start = '2022-01-03') {
  const out = []; const d = new Date(`${start}T05:00:00Z`);
  while (out.length < n) {
    if (d.getUTCDay() % 6 !== 0) { const c = f(out.length); out.push({ date: d.toISOString(), close: c, low: c * 0.99, high: c * 1.01 }); }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe('fridayKey / resampleToWeekly', () => {
  // Kite stamps Indian daily candles at midnight IST, which is the previous
  // evening in UTC. The old inline copies keyed weeks in the server's local
  // timezone, so on an IST machine every week carried its Thursday's date.
  test('Kite-style IST timestamps key to the same Friday, Monday to Friday', () => {
    for (const d of ['2026-11-09', '2026-11-11', '2026-11-13']) assert.equal(fridayKey(`${d}T00:00:00+05:30`), '2026-11-13');
  });
  test('every day of a week keys to its Friday', () => {
    for (const d of ['2026-11-09', '2026-11-11', '2026-11-13']) assert.equal(fridayKey(`${d}T05:00:00Z`), '2026-11-13');
    assert.equal(fridayKey('2026-11-16T05:00:00Z'), '2026-11-20');
  });
  test('a week is its last close, and its lowest low', () => {
    const w = resampleToWeekly([
      { date: '2026-11-09T05:00:00Z', close: 10, low: 9, high: 11 },
      { date: '2026-11-10T05:00:00Z', close: 12, low: 8, high: 13 },
      { date: '2026-11-12T05:00:00Z', close: 11, low: 10, high: 12 }, // Friday a holiday
    ]);
    assert.deepEqual(w, [{ date: '2026-11-13', close: 11, low: 8, high: 13, lastBar: '2026-11-12' }]);
  });
});

describe('rrgSeries', () => {
  test('a sector that tracks its benchmark exactly sits on 100 / 100', () => {
    const bench = daily(600, i => 100 + i * 0.1);
    const s = rrgSeries(bench.map(b => ({ ...b, close: b.close * 2 })), bench);
    assert.ok(s.length > 20);
    assert.ok(s.every(p => p.rsRatio === 100 && p.rsMomentum === 100));
  });
  test('needs 52 weeks for RS-Ratio and 26 more for RS-Momentum before the first point', () => {
    const bench = daily(600, () => 100);
    const s = rrgSeries(daily(600, i => 100 + i * 0.05), bench);
    const weeks = resampleToWeekly(bench).length;
    assert.equal(s.length, weeks - 77 + 1);
  });
  test('a steadily outperforming sector is Leading; too little history gives nothing', () => {
    const bench = daily(600, () => 100);
    const up = rrgSeries(daily(600, i => 100 * 1.001 ** i), bench).at(-1);
    assert.equal(quadrantOf(up.rsRatio, up.rsMomentum), 'Leading');
    assert.deepEqual(rrgSeries(daily(100, () => 50), daily(100, () => 100)), []);
  });
  // Not a unit test of arithmetic but the record of an equivalence check: on
  // 2026-11-16 this function, fed the same Alpaca bars the route reads,
  // returned exactly what GET /api/us/rrg had returned on 2026-11-14 for the
  // week of 2026-11-13 — ICLN 85.26 / 84.92, URA 72.64 / 82.32, XLE 112.17 /
  // 102.91. The boundaries below are the part of that agreement a unit test
  // can hold.
  test('100 counts as the strong side on both axes, as on the chart', () => {
    assert.equal(quadrantOf(100, 100), 'Leading');
    assert.equal(quadrantOf(100, 99.99), 'Weakening');
    assert.equal(quadrantOf(99.99, 100), 'Improving');
    assert.equal(quadrantOf(99.99, 99.99), 'Lagging');
  });
});

test('weekComplete waits for the Friday close in New York', () => {
  assert.equal(weekComplete('2026-11-13', new Date('2026-11-13T20:00:00Z')), false); // 15:00 EST
  assert.equal(weekComplete('2026-11-13', new Date('2026-11-13T21:20:00Z')), true);
  assert.equal(weekComplete('2026-11-20', new Date('2026-11-16T15:00:00Z')), false);
  assert.equal(weekComplete('2026-11-06', new Date('2026-11-09T01:00:00Z')), true);
});
