const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createWorkerFactory } = require('./gateway');

test('real workers have separate credential folders, callback ports and private HTTP gates', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kite-worker-test-'));
  const factory = createWorkerFactory({ root });
  const first = await factory();
  t.after(() => first.stop());
  const second = await factory();
  t.after(() => second.stop());
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.notEqual(first.port, second.port);
  assert.notEqual(first.callbackPort, second.callbackPort);
  assert.notEqual(first.directory, second.directory);
  assert.notEqual(first.secret, second.secret);
  for (const worker of [first, second]) {
    const base = `http://127.0.0.1:${worker.port}`;
    assert.equal((await fetch(base + '/api/profile')).status, 403);
    assert.equal((await fetch(base + '/api/profile', { headers: { 'x-kite-worker-secret': worker.secret } })).status, 401);
    assert.equal((await fetch(base + '/api/portfolios', { headers: { 'x-kite-worker-secret': worker.secret, 'x-user-id': 'GEK191' } })).status, 401);
    // No login tool is invoked. This test never requests broker or DB data.
  }
  await first.stop();
  assert.equal(second.isAlive(), true);
  await assert.rejects(fs.access(first.directory));
  await second.stop();
  assert.deepEqual(await fs.readdir(root), []);
});
