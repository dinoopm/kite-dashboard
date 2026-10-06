'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlertAuditService, alertEmission, summarizeObservations } = require('./alertAudit');

function alert({ score = 80, action = 'STRONG BUY', price = 100 } = {}) {
  return { symbol: 'A', token: 1, confidence: score, price, candleAsOf: '2026-10-05',
    tradePlan: { action }, signalInputs: { metrics: { rsi14: 65.23456 }, candles: [['2026-10-05', 90, 110, 80, 100, 1000]] } };
}
const now = () => new Date('2026-10-05T10:00:00Z');

test('records exact inputs, rule version, score scale, timestamp and cost assumptions', () => {
  const row = alertEmission(alert(), 'v1', now().toISOString());
  assert.equal(row.snap_date, '2026-10-05');
  assert.equal(row.meta.ruleVersion, 'v1');
  assert.equal(row.meta.scoreScale, '/100');
  assert.equal(row.meta.inputs.metrics.rsi14, 65.23456);
  assert.equal(row.meta.observedAt, now().toISOString());
  assert.equal(row.meta.costModel.feeBpsPerSide, 10);
  assert.equal(row.source, 'recorded');
});

test('dates an observation at input evaluation time in India, rather than persistence time', () => {
  const observation = alert();
  observation.signalInputs.evaluatedAt = '2026-10-05T18:00:00Z';
  const row = alertEmission(observation, 'v1', '2026-10-05T19:00:00Z');
  assert.equal(row.snap_date, '2026-10-05');
  assert.equal(row.meta.observedAt, observation.signalInputs.evaluatedAt);
});

test('weekend observations stay unresolved rather than shifting their entry to Monday', () => {
  const row = alertEmission(alert(), 'v1', '2026-10-04T10:00:00Z');
  const bars = Array.from({ length: 23 }, (_, index) => ({ date: index === 0 ? '2026-10-05' : `later-${index}`, close: 110, low: 90 }));
  const result = summarizeObservations([row], { seriesBySymbol: { A: bars } }, 'v1', now().toISOString());
  assert.equal(result.groups[0].horizons[0].n, 0);
  assert.equal(result.groups[0].horizons[0].unresolved, 1);
  assert.equal(result.recentObservations[0].outcomes['5d'], null);
});

test('duplicate and concurrent reads preserve the first observation', async () => {
  const saved = [];
  const service = createAlertAuditService({ ruleVersion: 'v1', now, store: async rows => { saved.push(...structuredClone(rows)); return rows.length; } });
  const results = await Promise.all([service.record([alert()]), service.record([alert({ price: 999 })])]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].meta.entryPrice, 100);
  assert.equal(results[1].status, 'unchanged');
  await service.record([alert({ action: 'BEARISH' })]);
  assert.equal(saved.length, 2);
});

test('storage failures are visible, can retry, and do not fail signal delivery', async () => {
  let attempts = 0;
  const service = createAlertAuditService({ ruleVersion: 'v1', now, store: async rows => {
    if (++attempts === 1) throw new Error('offline');
    return rows.length;
  } });
  assert.equal((await service.record([alert()])).status, 'failed');
  assert.equal((await service.record([alert()])).status, 'recorded');
  const unavailable = createAlertAuditService({ ruleVersion: 'v1', now });
  assert.equal((await unavailable.record([alert()])).status, 'unavailable');
  await assert.rejects(unavailable.trackRecord(), error => error.statusCode === 503);
});

test('version and score-band cohorts stay separate; snapshots use the observed entry quote', () => {
  const rows = [
    alertEmission(alert(), 'v1', now().toISOString()),
    alertEmission(alert({ score: 50 }), 'v1', now().toISOString()),
    alertEmission(alert({ price: 200 }), 'v2', now().toISOString()),
  ];
  const bars = Array.from({ length: 23 }, (_, index) => ({ date: index === 0 ? '2026-10-05' : `later-${index}`, close: 110, low: 90 }));
  const result = summarizeObservations(rows, { seriesBySymbol: { A: bars } }, 'v2', now().toISOString());
  assert.equal(result.groups.length, 3);
  assert.equal(result.groups.filter(group => group.currentRules).length, 1);
  assert.equal(result.groups[0].horizons[0].medianGrossPct, 10);
  assert.equal(result.groups[2].horizons[0].medianGrossPct, -45);
  assert.equal(result.groups[0].horizons[0].medianMaxAdversePct, -10);
  assert.equal(result.groups[0].horizons[0].underSampled, true);
  assert.equal(result.recentObservations[0].inputs.rsi14, 65.23456);
});

test('empty track record avoids fetching price history', async () => {
  const service = createAlertAuditService({ ruleVersion: 'v1', now, fetchRows: async () => [], context: async () => { throw new Error('Should not fetch'); } });
  assert.deepEqual((await service.trackRecord()).groups, []);
});

test('BSE inputs stay separate and never get scored against NSE prices', () => {
  const nse = alert();
  nse.signalInputs.holding = { exchange: 'NSE' };
  const bse = alert();
  bse.signalInputs.holding = { exchange: 'BSE' };
  const rows = [alertEmission(nse, 'v1', now().toISOString()), alertEmission(bse, 'v1', now().toISOString())];
  assert.notEqual(rows[0].signal, rows[1].signal);
  const bars = Array.from({ length: 23 }, (_, index) => ({ date: index === 0 ? '2026-10-05' : `later-${index}`, close: 110, low: 90 }));
  const result = summarizeObservations(rows, { seriesBySymbol: { A: bars } }, 'v1', now().toISOString());
  assert.equal(result.groups[0].horizons[0].n, 1);
  assert.equal(result.groups[1].horizons[0].n, 0);
  assert.equal(result.groups[1].horizons[0].unresolved, 1);
  assert.equal(result.recentObservations.find(row => row.exchange === 'BSE').outcomes['5d'], null);
});
