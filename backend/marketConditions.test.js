const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSignal, monthsBefore, normalizePoints, createMarketConditionsService, DEFINITIONS } = require('./marketConditions');

const NOW = new Date('2026-10-14T12:00:00Z');
const definition = id => DEFINITIONS.find(item => item.id === id);
const obs = (date, value) => ({ observation_date: date, value });

test('month-end baselines clamp to the previous month rather than overflowing', () => {
  assert.equal(monthsBefore('2026-05-31', 3), '2026-02-28');
  assert.equal(monthsBefore('2024-05-31', 3), '2024-02-29');
  assert.equal(monthsBefore('2026-01-30', 3), '2025-10-30');
});

test('missing, malformed and future observations never become zero or current values', () => {
  const data = normalizePoints([
    obs('2026-10-12', null), obs('2026-10-12', ''), obs('2026-10-12', '.'),
    obs('2026-10-12', NaN), obs('2026-10-12', Infinity), obs('2026-02-30', 5),
    obs('2026-10-15', 7), obs('2026-10-13', -0.5), obs('2026-10-09', -0.7), obs('2026-10-13', -0.6),
  ], { today: '2026-10-14' });
  assert.deepEqual(data, [{ date: '2026-10-09', value: -0.7 }, { date: '2026-10-13', value: -0.6 }]);
  const empty = buildSignal(definition('nfci'), [obs('2026-10-12', null)], NOW);
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.value, null);
  assert.equal(empty.change3m, null);
  assert.equal(empty.level.tone, 'neutral');
});

test('a below-zero NFCI can still be tightening, with level and direction distinct', () => {
  const signal = buildSignal(definition('nfci'), [obs('2026-07-03', -0.6), obs('2026-07-10', -0.9), obs('2026-10-09', -0.4)], NOW);
  assert.equal(signal.status, 'available');
  assert.equal(signal.level.label, 'Looser than average');
  assert.equal(signal.level.tone, 'positive');
  assert.equal(signal.direction.label, 'Tightening');
  assert.equal(signal.direction.tone, 'negative');
  assert.equal(signal.change3m.value, 0.2);
  assert.equal(signal.change3m.fromDate, '2026-07-03');
  assert.equal(signal.change3m.cutoffDate, '2026-07-09');
});

test('three-month baseline does not use later observations or bridge a large gap', () => {
  const signal = buildSignal(definition('credit'), [obs('2026-06-01', 3), obs('2026-07-14', 4), obs('2026-10-13', 5)], NOW);
  assert.equal(signal.value, 5);
  assert.equal(signal.change3m, null);
  assert.equal(signal.status, 'partial');
  assert.equal(signal.direction.tone, 'neutral');
});

test('spread/yield changes use basis points, not relative percent changes', () => {
  const signal = buildSignal(definition('credit'), [obs('2026-07-13', 3), obs('2026-10-13', 3.4)], NOW);
  assert.equal(signal.change3m.value, 40);
  assert.equal(signal.change3m.unit, 'bps');
  assert.equal(signal.direction.label, 'Widening');
  const real = buildSignal(definition('realYield'), [obs('2026-07-13', 2.2), obs('2026-10-13', 2)], NOW);
  assert.equal(real.change3m.value, -20);
  assert.equal(real.direction.tone, 'positive');
});

test('stale observations keep dated data but neutralize level and direction', () => {
  const daily = buildSignal(definition('credit'), [obs('2026-07-06', 4), obs('2026-10-06', 3)], NOW);
  assert.equal(daily.stale, true);
  assert.equal(daily.status, 'stale');
  assert.equal(daily.asOf, '2026-10-06');
  assert.equal(daily.direction.label, 'Update overdue');
  assert.equal(daily.level.tone, 'neutral');
  assert.equal(daily.direction.tone, 'neutral');
  assert.equal(buildSignal(definition('nfci'), [obs('2026-09-30', -0.4)], NOW).stale, false);
  assert.equal(buildSignal(definition('nfci'), [obs('2026-09-29', -0.4)], NOW).stale, true);
});

function priceRows(count = 240) {
  const end = Date.parse('2026-10-13T00:00:00Z');
  return Array.from({ length: count }, (_, i) => ({ date: new Date(end - (count - i - 1) * 86400000), close: 100 + i }));
}

test('200-day average requires exactly 200 valid unique closes; missing is not flat', () => {
  const partial = buildSignal(definition('sp500'), priceRows(199), NOW);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.movingAverage200, null);
  assert.equal(partial.distanceFromAveragePct, null);
  assert.equal(partial.level.tone, 'neutral');
  const complete = buildSignal(definition('sp500'), priceRows(200), NOW);
  assert.equal(complete.status, 'available');
  assert.equal(complete.movingAverage200, 199.5);
  assert.equal(complete.value, 299);
  assert.equal(complete.level.label, 'Above 200-day average');
  assert.ok(Math.abs(complete.distanceFromAveragePct - (299 / 199.5 - 1) * 100) < 1e-9);
});

test('moving average uses latest 200 closes; current New York session is excluded', () => {
  const rows = priceRows(240);
  rows.push({ date: new Date('2026-10-14T13:30:00Z'), close: 99999 });
  rows.push({ date: new Date('2026-10-15T13:30:00Z'), close: 99999 });
  const signal = buildSignal(definition('nasdaq100'), rows, NOW);
  assert.equal(signal.value, 339);
  assert.equal(signal.asOf, '2026-10-13');
  assert.equal(signal.movingAverage200, 239.5);
  assert.equal(signal.observationCount, 240);
  assert.equal(signal.history.length, 65);
  assert.equal(signal.history.at(-1).value, 339);
  assert.equal(signal.change3m.unit, 'percent');
});

function fredData() {
  return { series: Object.fromEntries(DEFINITIONS.filter(d => d.seriesId).map(d => [d.seriesId, { observations: [obs('2026-07-13', 1), obs('2026-10-13', 2)] }])), errors: {} };
}

test('partial FRED and index failures preserve independent successful signals and retry soon', async () => {
  let calls = 0;
  let time = NOW.getTime();
  const service = createMarketConditionsService({
    now: () => new Date(time),
    fredFetchMany: async () => { calls++; const data = fredData(); delete data.series.NFCI; data.errors.NFCI = 'failure'; return data; },
    indexFetch: async symbol => { if (symbol === '^NDX') throw new Error('failed'); return priceRows(); },
  });
  const data = await service();
  assert.equal(data.status, 'partial');
  assert.equal(data.signals.find(s => s.id === 'nfci').status, 'unavailable');
  assert.equal(data.signals.find(s => s.id === 'credit').status, 'available');
  assert.equal(data.signals.find(s => s.id === 'sp500').status, 'available');
  assert.equal(data.signals.find(s => s.id === 'nasdaq100').status, 'unavailable');
  assert.equal(data.signals.find(s => s.id === 'breadth').value, null);
  assert.equal(data.signals.find(s => s.id === 'earnings').value, null);
  await service();
  assert.equal(calls, 1);
  time += 31000;
  await service();
  assert.equal(calls, 2);
});

test('a FRED transport failure preserves both equity trends', async () => {
  const service = createMarketConditionsService({ now: () => NOW,
    fredFetchMany: async () => { throw new Error('transport down'); }, indexFetch: async () => priceRows(),
  });
  const data = await service();
  assert.equal(data.signals.filter(s => s.status === 'available').length, 2);
  assert.equal(data.status, 'partial');
});

test('success is cached for 15 minutes, simultaneous requests coalesce, optional cards stay unavailable', async () => {
  let calls = 0;
  let time = NOW.getTime();
  const service = createMarketConditionsService({ now: () => new Date(time),
    fredFetchMany: async () => { calls++; return fredData(); }, indexFetch: async () => priceRows(),
  });
  const [first, second] = await Promise.all([service(), service()]);
  assert.equal(first.status, 'available');
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  assert.equal(first.signals.filter(s => s.status === 'unavailable').length, 2);
  time += 14 * 60000;
  await service();
  assert.equal(calls, 1);
  time += 60001;
  await service();
  assert.equal(calls, 2);
});
