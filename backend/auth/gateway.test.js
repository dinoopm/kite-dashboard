const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createGateway, cookieToken } = require('./gateway');

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return server;
}
async function fixture(t, options = {}) {
  const workers = [];
  const accounts = [
    { appUserId: '11111111-1111-4111-8111-111111111111', kiteUserId: 'GEK191' },
    { appUserId: '22222222-2222-4222-8222-222222222222', kiteUserId: 'ABC123' },
  ];
  const gateway = createGateway({ ...options, allowedOrigins: ['http://localhost:5173'], workerFactory: async () => {
    const app = express(); app.use(express.json());
    const worker = { identity: accounts[workers.length % accounts.length], verified: false, stopped: false, rows: [], secret: `secret-${workers.length}` };
    workers.push(worker);
    app.use((req, res, next) => { assert.equal(req.get('x-kite-worker-secret'), worker.secret); next(); });
    app.post('/api/login', (req, res) => res.json({ content: [{ text: 'Authorize your private session' }] }));
    app.get('/api/profile', (req, res) => {
      if (worker.profileFailure) return res.status(worker.profileFailure).json({ error: 'Profile unavailable' });
      if (!worker.verified) return res.status(401).json({ error: 'Broker not authorized' });
      res.json({ identity: worker.identity, content: [{ text: JSON.stringify({ data: { user_id: worker.identity.kiteUserId } }) }] });
    });
    app.get('/api/holdings', (req, res) => res.json({ account: worker.identity.kiteUserId, rows: worker.rows }));
    app.post('/api/portfolios', (req, res) => { worker.rows.push({ name: req.body.name, user_id: worker.identity.appUserId }); res.json(worker.rows); });
    app.get('/api/limited', (req, res) => res.set('Retry-After', '17').status(429).json({ error: 'rate_limited' }));
    const server = await listen(app);
    return Object.assign(worker, { port: server.address().port, isAlive: () => !worker.stopped,
      stop: async () => { worker.stopped = true; await new Promise(resolve => server.close(resolve)); },
    });
  } });
  const server = await listen(gateway.app);
  t.after(async () => { await gateway.close(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  function browser() {
    let cookie = '';
    return {
      get cookie() { return cookie; },
      async request(route, { headers = {}, ...init } = {}) {
        const response = await fetch(base + route, { ...init, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
        const updated = response.headers.get('set-cookie');
        if (updated) cookie = updated.split(';')[0];
        return response;
      },
    };
  }
  return { gateway, browser, workers, base };
}

test('anonymous requests cannot inherit existing account; each login rotates and owns its worker', async t => {
  const { gateway, browser, workers } = await fixture(t);
  const alice = browser(); const bob = browser(); const anonymous = browser();
  assert.equal((await alice.request('/api/profile')).status, 401);
  assert.equal(workers.length, 0);
  assert.equal((await alice.request('/api/login', { method: 'POST' })).status, 200);
  const pending = alice.cookie;
  assert.equal((await alice.request('/api/holdings')).status, 401);
  workers[0].verified = true;
  const profile = await (await alice.request('/api/profile')).json();
  assert.equal(profile.identity.kiteUserId, 'GEK191');
  assert.notEqual(alice.cookie, pending);
  assert.equal(gateway.sessions.has(cookieToken(pending)), false);
  assert.equal((await anonymous.request('/api/holdings', { headers: { 'x-user-id': 'GEK191' } })).status, 401);
  await bob.request('/api/login', { method: 'POST' }); workers[1].verified = true; await bob.request('/api/profile');
  await alice.request('/api/portfolios', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-id': 'ABC123', 'x-kite-worker-secret': 'forged' }, body: JSON.stringify({ name: 'Private', user_id: workers[1].identity.appUserId }) });
  assert.deepEqual((await (await alice.request('/api/holdings')).json()).rows, [{ name: 'Private', user_id: workers[0].identity.appUserId }]);
  assert.deepEqual((await (await bob.request('/api/holdings')).json()).rows, []);
  await alice.request('/api/disconnect', { method: 'POST' });
  assert.equal(workers[0].stopped, true); assert.equal(workers[1].stopped, false);
  assert.equal((await alice.request('/api/holdings')).status, 401);
  assert.equal((await bob.request('/api/holdings')).status, 200);
});

test('gateway preserves rate limits, rejects hostile origins and uses private HttpOnly cookies', async t => {
  const { browser, workers } = await fixture(t, { secureCookies: true });
  const client = browser();
  assert.equal((await client.request('/api/login', { method: 'POST', headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal(workers.length, 0);
  const login = await client.request('/api/login', { method: 'POST', headers: { Origin: 'http://localhost:5173' } });
  const cookie = login.headers.get('set-cookie');
  for (const flag of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/']) assert.ok(cookie.includes(flag));
  workers[0].verified = true; await client.request('/api/profile');
  const limit = await client.request('/api/limited');
  assert.equal(limit.status, 429); assert.equal(limit.headers.get('Retry-After'), '17');
  assert.equal(limit.headers.get('Cache-Control'), 'private, no-store');
});

test('expired, dead or account-switched sessions close their own worker; database failure cannot authenticate', async t => {
  let time = 0;
  const { browser, workers, gateway } = await fixture(t, { now: () => time, idleMs: 100, pendingMs: 200 });
  const client = browser();
  await client.request('/api/login', { method: 'POST' });
  workers[0].profileFailure = 503;
  assert.equal((await client.request('/api/profile')).status, 503);
  assert.equal((await client.request('/api/holdings')).status, 401);
  workers[0].profileFailure = null; workers[0].verified = true; await client.request('/api/profile');
  time = 101; await gateway.sweep();
  assert.equal(workers[0].stopped, true);
  assert.equal((await client.request('/api/profile')).status, 401);
  await client.request('/api/login', { method: 'POST' }); workers[1].verified = true; await client.request('/api/profile');
  workers[1].identity = { appUserId: 'other-account', kiteUserId: 'OTHER123' };
  assert.equal((await client.request('/api/profile')).status, 401);
  assert.equal(workers[1].stopped, true);
});

test('login capacity is bounded and invalidation cannot reuse a pending cookie', async t => {
  const { browser, workers } = await fixture(t, { maxSessions: 1 });
  const first = browser(); const second = browser();
  await first.request('/api/login', { method: 'POST' });
  assert.equal((await second.request('/api/login', { method: 'POST' })).status, 503);
  assert.equal(workers.length, 1);
  await first.request('/api/disconnect', { method: 'POST' });
  assert.equal((await second.request('/api/login', { method: 'POST' })).status, 200);
});
