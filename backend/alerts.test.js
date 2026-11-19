const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.HEALTH_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-'));
const { planAlerts, notifyFromStatus, REMIND_MS } = require('./alerts');

const T0 = Date.parse('2026-11-19T21:00:00Z');
const fail = (id, summary = 'x') => ({ id, label: id.toUpperCase(), state: 'fail', summary });
const ok = (id, summary = 'fine') => ({ id, label: id.toUpperCase(), state: 'ok', summary });

describe('planAlerts', () => {
  test('a new failure is announced once, not on every pass', () => {
    const a = planAlerts({ failing: {} }, [fail('scraper', 'Run FII/DII Scraper failed')], T0);
    assert.deepEqual(a.messages.map(m => [m.kind, m.title]), [['broken', 'Broken: SCRAPER']]);
    const b = planAlerts(a.next, [fail('scraper')], T0 + 30 * 60 * 1000);
    assert.deepEqual(b.messages, []);
  });

  test('a failure that lasts a day gets one reminder', () => {
    const a = planAlerts({ failing: {} }, [fail('job')], T0);
    const b = planAlerts(a.next, [fail('job')], T0 + REMIND_MS);
    assert.deepEqual(b.messages.map(m => m.kind), ['still']);
    assert.match(b.messages[0].body, /^Since 2026-11-19 21:00 UTC/);
    assert.deepEqual(planAlerts(b.next, [fail('job')], T0 + REMIND_MS + 3600e3).messages, []);
  });

  test('a recovery is announced, and the failure forgotten', () => {
    const a = planAlerts({ failing: {} }, [fail('feed')], T0);
    const b = planAlerts(a.next, [ok('feed', 'Current — last 2026-11-19')], T0 + 3600e3);
    assert.deepEqual(b.messages.map(m => [m.kind, m.title, m.body]), [['recovered', 'Recovered: FEED', 'Current — last 2026-11-19']]);
    assert.deepEqual(b.next.failing, {});
  });

  // A check missing from one pass (GitHub unreachable, say) has not recovered.
  test('a failing check that disappears is neither recovered nor forgotten', () => {
    const a = planAlerts({ failing: {} }, [fail('wf')], T0);
    const b = planAlerts(a.next, [], T0 + 3600e3);
    assert.deepEqual(b.messages, []);
    assert.ok(b.next.failing.wf);
  });

  test('warnings never notify', () => {
    assert.deepEqual(planAlerts({ failing: {} }, [{ id: 'orphans', label: 'X', state: 'warn', summary: 's' }], T0).messages, []);
  });
});

test('notifyFromStatus sends each message where configured and remembers it across restarts', async () => {
  const desktop = []; const hooks = [];
  const deps = { now: T0, env: { NOTIFY_WEBHOOK_URL: 'https://example.org/topic' }, desktop: async (m) => { desktop.push(m.title); return true; }, webhook: async (u, m) => { hooks.push([u, m.title]); return true; } };
  const r = await notifyFromStatus({ checks: [fail('scorecard')] }, deps);
  assert.deepEqual(r.sent.map(s => [s.title, s.via]), [['Broken: SCORECARD', process.platform === 'darwin' ? ['desktop', 'webhook'] : ['webhook']]]);
  assert.deepEqual(hooks, [['https://example.org/topic', 'Broken: SCORECARD']]);
  // Same failure on the next pass (e.g. after a restart): nothing new is sent.
  const again = await notifyFromStatus({ checks: [fail('scorecard')] }, { ...deps, now: T0 + 1800e3 });
  assert.deepEqual(again.sent, []);
  // No webhook configured, desktop off: nothing goes anywhere, state still advances.
  const quiet = await notifyFromStatus({ checks: [ok('scorecard')] }, { ...deps, now: T0 + 3600e3, env: { NOTIFY_DESKTOP: '0' } });
  assert.deepEqual(quiet.sent.map(s => [s.kind, s.via]), [['recovered', []]]);
});
