const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { DEFAULT_THRESHOLDS: C } = require('./thresholds.ts');
const { validationBadge, configFingerprint } = require('./validation');
const { main, parseArgs, csv } = require('./backtest');
const fallback = { headline: { state: 'unscoreable', text: 'Unvalidated severity rule', detail: 'No complete study.' } };
test('only complete matching point-in-time results replace unvalidated badge, including failed lead', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'severity-validation-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); const file = path.join(dir, 'latest.json');
  assert.equal(await validationBadge(fallback, 'v1', C, file), fallback);
  const base = { ruleVersion: 'v1', configFingerprint: configFingerprint(C), coverage: { complete: true }, provenance: 'point-in-time', status: 'failed-warning', tiers: [{ tier: 'STRESS', medianLeadSessions: -2, falsePositiveRatePct: 40, leadEvents: 4, resolvedReadings: 100 }] };
  for (const patch of [{ ruleVersion: 'v0' }, { configFingerprint: 'old' }, { coverage: { complete: false } }, { provenance: 'current-history' }]) {
    await fs.writeFile(file, JSON.stringify({ ...base, ...patch })); assert.equal((await validationBadge(fallback, 'v1', C, file)).headline.text, fallback.headline.text);
  }
  await fs.writeFile(file, JSON.stringify(base)); const badge = await validationBadge(fallback, 'v1', C, file); assert.equal(badge.headline.state, 'negative'); assert.match(badge.headline.text, /-2.0 sessions/);
});
test('offline CLI writes honest blocked CSV/markdown artifacts and nonzero exit without archive', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'severity-cli-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { code, result } = await main(['--out', dir], { latestPath: path.join(dir, 'ui.json'), probe: async () => ({ error: 'No vintage archive', first: '2023-11-01', last: '2026-10-23' }) });
  assert.equal(code, 2); assert.equal(result.status, 'blocked'); assert.equal(result.tiers, undefined);
  assert.match(await fs.readFile(path.join(dir, 'report.md'), 'utf8'), /No vintage archive/);
  for (const name of ['tiers.csv', 'strategies.csv', 'coverage.csv', 'classifications.csv', 'lead-times.csv', 'equity.csv', 'trades.csv', 'latest.json']) assert.ok((await fs.stat(path.join(dir, name))).size > 0);
  assert.throws(() => parseArgs(['--input'])); assert.throws(() => parseArgs(['--bad'])); assert.equal(csv(['a'], [{ a: 'a,b' }]), 'a\n"a,b"\n');
});

test('complete archive traverses CLI coverage and produces measured zero-lead failure', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'severity-full-fixture-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sessions = [], observations = Object.fromEntries(['SPY', 'TLT', 'VIX', 'HY_OAS'].map(s => [s, []]));
  const shock = ['2020-03-02', '2020-03-03', '2020-03-04', '2020-03-05', '2020-03-06'];
  for (let d = Date.parse('2005-01-01'); d <= Date.parse('2022-12-30'); d += 864e5) {
    if ([0, 6].includes(new Date(d).getUTCDay())) continue;
    const date = new Date(d).toISOString().slice(0, 10), n = shock.indexOf(date), price = n < 0 ? 100 : [98, 95, 90, 85, 80][n];
    sessions.push({ date, openAt: date + 'T14:30:00Z', closeAt: date + 'T21:00:00Z', spyOpen: price, spyClose: price });
    for (const symbol of Object.keys(observations)) observations[symbol].push({ date, value: symbol === 'SPY' ? price : symbol === 'TLT' ? 100 : symbol === 'VIX' ? (n >= 0 ? 25 : 14) : (n >= 0 ? 3.5 : 3), availableAt: date + 'T20:59:00Z', vintage: 'test-only', source: 'synthetic test only' });
  }
  const input = path.join(dir, 'archive.json');
  await fs.writeFile(input, JSON.stringify({ schemaVersion: 1, provenance: { kind: 'point-in-time', source: 'synthetic test only, not market evidence', calendarSource: 'synthetic weekdays, not a real exchange calendar' }, sessions, observations }));
  const { code, result } = await main(['--input', input, '--end', '2022-12-30', '--out', dir], { latestPath: path.join(dir, 'ui.json') });
  assert.equal(result.coverage.complete, true); assert.equal(code, 1); assert.equal(result.status, 'failed-warning');
  assert.equal(result.tiers.find(r => r.tier === 'STRESS').medianLeadSessions, 0);
  assert.ok(result.comparison.strategy.allocationChanges > 0);
  assert.match(await fs.readFile(path.join(dir, 'tiers.csv'), 'utf8'), /STRESS/);
});
