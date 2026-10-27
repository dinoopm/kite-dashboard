const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_THRESHOLDS: C } = require('./thresholds.ts');
const { versionCursor, reconstruct, validateDataset, coverageFor } = require('./replay');
const config = { ...C, highSessions: 3, rotationSessions: 2, rapidSessions: 1 };
function archive() {
  const dates = ['2020-01-02', '2020-01-03', '2020-01-06', '2020-01-07', '2020-01-08'];
  return { schemaVersion: 1, provenance: { kind: 'point-in-time', source: 'unit fixture', calendarSource: 'unit exchange calendar' }, sessions: dates.map(date => ({ date, openAt: date + 'T14:30:00Z', closeAt: date + 'T21:00:00Z', spyOpen: 100, spyClose: 101 })), observations: Object.fromEntries(['SPY', 'TLT', 'VIX', 'HY_OAS'].map(symbol => [symbol, dates.map((date, i) => ({ date, value: symbol === 'SPY' ? 100 + i : symbol === 'TLT' ? 100 : symbol === 'VIX' ? 14 : 3, availableAt: date + 'T20:59:00Z', source: 'unit', vintage: 'original' }))])) };
}
test('vintage cursor never sees late releases or revisions before their availableAt', () => {
  const c = versionCursor([{ date: '2020-01-02', value: 1, availableAt: '2020-01-02T21:01:00Z' }, { date: '2020-01-02', value: 2, availableAt: '2020-01-03T20:00:00Z' }]);
  c.advance(Date.parse('2020-01-02T21:00:00Z')); assert.equal(c.visible.size, 0);
  c.advance(Date.parse('2020-01-02T21:02:00Z')); assert.equal(c.visible.get('2020-01-02').value, 1);
  c.advance(Date.parse('2020-01-03T21:00:00Z')); assert.equal(c.visible.get('2020-01-02').value, 2);
});
test('replay aligns every input and does not use a post-close credit release', () => {
  const a = archive(); a.observations.HY_OAS.at(-1).availableAt = '2020-01-08T21:01:00Z';
  const result = reconstruct(a, config, { start: '2020-01-06', end: '2020-01-08' });
  assert.equal(result.rows.at(-1).basisDate, '2020-01-07');
  assert.ok(result.rows.at(-1).vintages.filter(v => v.availableAt).every(v => v.observationDate === '2020-01-07'));
  a.observations.SPY.push({ ...a.observations.SPY[2], value: 1, availableAt: '2020-01-08T21:01:00Z', vintage: 'revision' });
  assert.deepEqual(reconstruct(a, config, { start: '2020-01-06', end: '2020-01-08' }).rows, result.rows);
});
test('missing SPY sessions are not compressed out of windows; optional CCC does not move date', () => {
  const a = archive(); a.observations.SPY.splice(2, 1);
  const last = reconstruct(a, config, { start: '2020-01-08', end: '2020-01-08' }).rows[0];
  assert.equal(last.basisDate, '2020-01-08'); assert.equal(last.tier, 'INCOMPLETE');
  const clean = reconstruct(archive(), config, { start: '2020-01-08', end: '2020-01-08' }).rows[0];
  assert.equal(clean.tier, 'NEUTRAL'); assert.equal(clean.flags.cccLeadership, false);
});
test('archive requires explicit timestamp/timezone and provenance; short samples fail coverage', () => {
  for (const mutate of [a => a.provenance.kind = 'current-history', a => a.observations.HY_OAS[0].availableAt = '2020-01-02', a => a.sessions[0].closeAt = '2020-01-02T21:00:00', a => a.sessions.push(a.sessions[0])]) {
    const a = archive(); mutate(a); assert.throws(() => validateDataset(a));
  }
  const rows = reconstruct(archive(), config, { start: '2020-01-06', end: '2020-01-08' }).rows;
  const coverage = coverageFor(rows, { start: '2007-01-01', end: '2020-01-08' }); assert.equal(coverage.complete, false); assert.equal(coverage.episodes.length, 7);
});
