const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, fetchWorkflows } = require('./systemStatus');

const NOW = Date.parse('2026-11-19T12:00:00Z');
const iso = (hoursAgo) => new Date(NOW - hoursAgo * 3600 * 1000).toISOString();
const ok = (hoursAgo, detail = 'ran') => ({ lastOk: true, lastOkAt: iso(hoursAgo), lastRunAt: iso(hoursAgo), lastDetail: detail });
const healthy = () => ({
  tick: { ranAt: iso(0.2), finishedAt: iso(0.2) },
  scheduled: { startedAt: iso(30), tickMs: 30 * 60 * 1000 },
  outcomes: Object.fromEntries(['picks', 'emissions', 'macro', 'usPicks', 'usRiskSeverity', 'riskRegime', 'rrgRotation'].map(k => [`job-${k}`, ok(0.2)])),
});
const find = (r, id) => r.checks.find(c => c.id === id);

describe('evaluate', () => {
  test('a healthy system has no failures and raises no banner', () => {
    const r = evaluate(healthy(), NOW);
    assert.equal(r.ok, true);
    assert.equal(r.counts.fail, 0);
  });

  test('a job whose last run failed is a failure, with its error and streak', () => {
    const i = healthy();
    i.outcomes['job-picks'] = { lastOk: false, lastOkAt: iso(26), lastErrorAt: iso(0.5), lastError: 'statement timeout', consecutiveFailures: 3 };
    const c = find(evaluate(i, NOW), 'job-picks');
    assert.equal(c.state, 'fail');
    assert.match(c.summary, /statement timeout/);
    assert.match(c.summary, /3 runs in a row/);
  });

  // A job that silently stopped being run — no error, just nothing — while the
  // scheduler keeps ticking. The case nothing else would catch.
  test('a job with no success for longer than its quiet window, while the scheduler ticks, has stopped', () => {
    const i = healthy();
    i.outcomes['job-emissions'] = ok(9);
    assert.equal(find(evaluate(i, NOW), 'job-emissions').state, 'fail');
    i.outcomes['job-rrgRotation'] = ok(9); // weekly job, 30 h window
    assert.equal(find(evaluate(i, NOW), 'job-rrgRotation').state, 'ok');
  });

  test('a scheduler with no pass for over two and a half ticks has stopped', () => {
    const i = healthy();
    i.tick = { ranAt: iso(2), finishedAt: iso(2) };
    const c = find(evaluate(i, NOW), 'scheduler');
    assert.equal(c.state, 'fail');
    assert.match(c.action, /npm start/);
  });

  test('never-run and not-yet-built are unknown, not alarms', () => {
    const r = evaluate({ outcomes: {} }, NOW);
    assert.equal(r.counts.fail, 0);
    assert.equal(find(r, 'scheduler').state, 'unknown');
    assert.equal(find(r, 'scorecard-india-signals').state, 'unknown');
  });

  // The failure that started this: badges hide when their scorecard fails.
  test('a scorecard whose last build failed is a failure until a later build succeeds', () => {
    const i = healthy();
    i.outcomes['scorecard-india-signals'] = { lastOk: false, lastErrorAt: iso(1), lastError: 'canceling statement due to statement timeout', lastOkAt: iso(48) };
    assert.equal(find(evaluate(i, NOW), 'scorecard-india-signals').state, 'fail');
    i.outcomes['scorecard-india-signals'] = { lastOk: true, lastErrorAt: iso(5), lastError: 'x', lastOkAt: iso(1), lastDetail: '45 entries' };
    assert.equal(find(evaluate(i, NOW), 'scorecard-india-signals').state, 'ok');
  });

  test('a stale or gapped feed fails; one that could not be checked only warns', () => {
    const i = { ...healthy(), feeds: { feeds: [
      { table: 'fii_dii_activity', label: 'FII / DII flows', stale: true, sessionsBehind: 3, last: '2026-11-13' },
      { table: 'nse_bhavcopy', label: 'Bhavcopy', gaps: ['2026-07-03'], last: '2026-11-18' },
      { table: 'volume_gainers', label: 'Volume gainers', error: 'timeout' },
      { table: 'stock_pick_snapshots', label: 'Picks', last: '2026-11-18', gaps: [] },
    ] } };
    const r = evaluate(i, NOW);
    assert.deepEqual(['feed-fii_dii_activity', 'feed-nse_bhavcopy', 'feed-volume_gainers', 'feed-stock_pick_snapshots'].map(id => find(r, id).state), ['fail', 'fail', 'warn', 'ok']);
  });

  test('a failed workflow run fails and names its failed steps; an unreachable GitHub only warns', () => {
    const i = { ...healthy(), workflows: { runs: [{ name: 'Market Data Sync', path: 'a.yml', conclusion: 'failure', at: iso(15), failedSteps: ['Run FII/DII Scraper'] }] } };
    const c = find(evaluate(i, NOW), 'wf-a.yml');
    assert.equal(c.state, 'fail');
    assert.match(c.summary, /Run FII\/DII Scraper/);
    assert.equal(find(evaluate({ ...healthy(), workflows: { error: 'GitHub 403' } }, NOW), 'workflows').state, 'warn');
  });

  // Pending restarts and stray processes are worth knowing, not alarms.
  test('code older than the files on disk, and orphaned workers, warn with what to do', () => {
    const i = { ...healthy(), newestSource: { file: 'backend/x.js', mtime: iso(1) }, gateway: { startedAt: iso(5) }, worker: { startedAt: iso(0.5) },
      processes: { workers: 1, orphans: [{ pid: 45571, started: '2026-10-08' }, { pid: 12305, started: '2026-10-09' }] } };
    const r = evaluate(i, NOW);
    assert.equal(find(r, 'code-gateway').state, 'warn');
    assert.match(find(r, 'code-gateway').action, /npm start/);
    assert.equal(find(r, 'code-worker').state, 'ok');
    assert.equal(find(r, 'orphans').state, 'warn');
    assert.equal(find(r, 'orphans').action, 'Stop them with: kill 45571 12305');
    assert.equal(r.ok, true);
  });

  test('failures sort first', () => {
    const i = healthy();
    i.outcomes['job-macro'] = { lastOk: false, lastErrorAt: iso(1), lastError: 'x' };
    assert.equal(evaluate(i, NOW).checks[0].id, 'job-macro');
  });
});

test('fetchWorkflows keeps the latest completed run per workflow and reads failed steps', async () => {
  const pages = {
    '/actions/runs?per_page=40&event=schedule': { workflow_runs: [
      { id: 3, name: 'Market Data Sync', path: 'm.yml', status: 'in_progress', conclusion: null, created_at: '2026-11-19T11:00:00Z' },
      { id: 2, name: 'Market Data Sync', path: 'm.yml', status: 'completed', conclusion: 'failure', created_at: '2026-11-18T21:00:00Z', html_url: 'u2' },
      { id: 1, name: 'Market Data Sync', path: 'm.yml', status: 'completed', conclusion: 'success', created_at: '2026-11-17T21:00:00Z' },
      { id: 9, name: 'Macro Data Sync', path: 'x.yml', status: 'completed', conclusion: 'success', created_at: '2026-11-18T21:00:00Z' },
    ] },
    '/actions/runs/2/jobs': { jobs: [{ steps: [{ name: 'Run FII/DII Scraper', conclusion: 'failure' }, { name: 'Run Bhavcopy Scraper', conclusion: 'success' }] }] },
  };
  const fetchImpl = async (url) => {
    const key = url.replace('https://api.github.com/repos/o/r', '');
    return { ok: true, json: async () => pages[key] };
  };
  const r = await fetchWorkflows('o/r', { fetchImpl });
  assert.deepEqual(r.runs.map(w => [w.name, w.conclusion, w.failedSteps]), [['Macro Data Sync', 'success', []], ['Market Data Sync', 'failure', ['Run FII/DII Scraper']]]);
  assert.equal((await fetchWorkflows(null)).error, 'no GitHub remote configured');
});
