const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

// Client construction is harmless; every query below uses an injected double.
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_KEY = 'briefing-test-key';
const { composeBriefing, createBriefingService } = require('./briefing');

function fakeDatabase({ previous = [], readError = null, writeError = null } = {}) {
  const calls = [];
  const tables = new Set(['fii_dii_activity', 'macro_events', 'stock_pick_snapshots', 'holding_state_snapshots']);
  return {
    calls,
    from(table) {
      assert.ok(tables.has(table), `Unexpected table: ${table}`);
      let operation = 'select';
      const query = {
        select(columns) {
          calls.push({ table, operation: 'select', columns });
          return query;
        },
        upsert(rows, options) {
          operation = 'upsert';
          calls.push({ table, operation, rows, options });
          return query;
        },
        then(resolve, reject) {
          const result = operation === 'upsert'
            ? { data: null, error: writeError }
            : table === 'holding_state_snapshots'
              ? { data: previous, error: readError }
              : { data: [], error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      for (const method of ['lt', 'gte', 'lte', 'eq', 'order', 'limit']) {
        query[method] = (...args) => {
          calls.push({ table, operation: method, args });
          return query;
        };
      }
      return query;
    },
  };
}

const holding = (changes = {}) => ({
  symbol: 'ABC', token: 123, score: 0, badges: [], signal: null, ...changes,
});

async function briefing(t, database, getXray) {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected network access in briefing test');
  });
  return composeBriefing({ database, getXray, getQuotes: async () => ({}) });
}

function assertUnavailable(result, message) {
  assert.equal(result.holdingsAvailable, false);
  assert.equal(result.quiet, false);
  assert.equal(result.holdings.length, 1);
  assert.equal(result.holdings[0].tone, 'neutral');
  assert.equal(result.holdings[0].link, '/portfolio');
  assert.match(result.holdings[0].text, /^Holdings deltas unavailable:/);
  assert.ok(result.holdings[0].text.includes(message));
}

describe('composeBriefing holdings deltas', () => {
  test('first successful day seeds the snapshot and reports an available baseline', async t => {
    const database = fakeDatabase();
    const result = await briefing(t, database, async () => ({ holdings: [holding()] }));

    assert.equal(result.holdingsAvailable, true);
    assert.deepEqual(result.holdings, []);
    assert.equal(result.quiet, true);
    for (const section of ['market', 'picks', 'events', 'expiry']) assert.deepEqual(result[section], []);
    for (const table of ['fii_dii_activity', 'macro_events', 'stock_pick_snapshots']) {
      assert.ok(database.calls.some(call => call.table === table && call.operation === 'select'));
    }
    const writes = database.calls.filter(call => call.operation === 'upsert');
    assert.deepEqual(writes, [{
      table: 'holding_state_snapshots', operation: 'upsert',
      rows: [{ snap_date: result.date, symbol: 'ABC', score: 0, badge_ids: '', signal: null }],
      options: { onConflict: 'snap_date,symbol' },
    }]);
    assert.deepEqual(database.calls.find(call => call.operation === 'lt').args, ['snap_date', result.date]);
  });

  test('reports new adverse badges and a bearish signal flip against the prior snapshot', async t => {
    const database = fakeDatabase({ previous: [{
      snap_date: '2000-01-01', symbol: 'ABC', score: 1, badge_ids: 'existing', signal: 'HOLD',
    }] });
    const current = holding({ score: 4, signal: 'TRIM', badges: [
      { id: 'existing', tone: 'warn', label: 'existing warning' },
      { id: 'new-risk', tone: 'alert', label: 'new warning', detail: 'synthetic detail' },
      { id: 'positive', tone: 'good', label: 'accumulation' },
    ] });
    const result = await briefing(t, database, async () => ({ holdings: [current] }));

    assert.equal(result.holdingsAvailable, true);
    assert.equal(result.quiet, false);
    assert.deepEqual(result.holdings, [{
      tone: 'alert', text: 'ABC: new — new warning (synthetic detail)', link: '/instrument/123?symbol=ABC',
    }, {
      tone: 'warn', text: 'ABC: technical signal flipped HOLD → TRIM', link: '/instrument/123?symbol=ABC',
    }]);
    const write = database.calls.find(call => call.operation === 'upsert');
    assert.deepEqual(write.rows, [{
      snap_date: result.date, symbol: 'ABC', score: 4, badge_ids: 'existing,new-risk,positive', signal: 'TRIM',
    }]);
  });

  test('shows unavailable holdings when X-Ray rejects without querying or writing snapshots', async t => {
    const database = fakeDatabase();
    const result = await briefing(t, database, async () => { throw new Error('X-Ray unavailable'); });

    assertUnavailable(result, 'X-Ray unavailable');
    assert.ok(!database.calls.some(call => call.table === 'holding_state_snapshots'));
  });

  test('snapshot read errors show unavailable holdings and do not overwrite the baseline', async t => {
    const database = fakeDatabase({ readError: { message: 'snapshot read failed' } });
    const result = await briefing(t, database, async () => ({ holdings: [holding()] }));

    assertUnavailable(result, 'snapshot read failed');
    assert.ok(database.calls.some(call => call.table === 'holding_state_snapshots' && call.operation === 'select'));
    assert.ok(!database.calls.some(call => call.operation === 'upsert'));
  });

  test('snapshot write errors show unavailable holdings rather than claiming there were no changes', async t => {
    const database = fakeDatabase({ writeError: { message: 'snapshot write failed' } });
    const result = await briefing(t, database, async () => ({ holdings: [holding()] }));

    assertUnavailable(result, 'snapshot write failed');
    assert.equal(database.calls.filter(call => call.operation === 'upsert').length, 1);
  });
});

describe('createBriefingService cache', () => {
  test('retries degraded holdings immediately and caches the next successful result', async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network access'); });
    const database = fakeDatabase();
    let xrayLoads = 0;
    let marketLoads = 0;
    const clock = Date.now();
    const getBriefing = createBriefingService({
      database,
      getQuotes: async () => { marketLoads++; return {}; },
      getXray: async () => {
        if (++xrayLoads === 1) throw new Error('temporary X-Ray failure');
        return { holdings: [holding()] };
      },
    }, { now: () => clock, ttlMs: 1000 });

    const failed = await getBriefing();
    assertUnavailable(failed, 'temporary X-Ray failure');
    const recovered = await getBriefing();
    assert.equal(recovered.holdingsAvailable, true);
    assert.deepEqual(recovered.holdings, []);
    assert.equal(recovered.quiet, true);
    const cached = await getBriefing();
    assert.deepEqual(cached, { ...recovered, cached: true });
    assert.equal(xrayLoads, 2);
    assert.equal(marketLoads, 2);
    assert.equal(database.calls.filter(call => call.operation === 'upsert').length, 1);
  });

  test('simultaneous requests compose only once and share the completed result', async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network access'); });
    const database = fakeDatabase();
    let releaseXray;
    const xrayReady = new Promise(resolve => { releaseXray = resolve; });
    let xrayLoads = 0;
    let marketLoads = 0;
    const clock = Date.now();
    const getBriefing = createBriefingService({
      database,
      getQuotes: async () => { marketLoads++; return {}; },
      getXray: async () => { xrayLoads++; return xrayReady; },
    }, { now: () => clock, ttlMs: 1000 });

    const first = getBriefing();
    const second = getBriefing();
    assert.equal(xrayLoads, 1);
    releaseXray({ holdings: [holding()] });
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(a.holdingsAvailable, true);
    assert.equal(xrayLoads, 1);
    assert.equal(marketLoads, 1);
    assert.equal(database.calls.filter(call => call.operation === 'upsert').length, 1);
    assert.equal((await getBriefing()).cached, true);
    assert.equal(xrayLoads, 1);
  });

  test('separate service instances keep holdings and cached results independent', async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network access'); });
    const clock = Date.now();
    const loads = { ABC: 0, XYZ: 0 };
    const serviceFor = symbol => createBriefingService({
      database: fakeDatabase({ previous: [{
        snap_date: '2000-01-01', symbol, badge_ids: '', signal: 'HOLD',
      }] }),
      getQuotes: async () => ({}),
      getXray: async () => {
        loads[symbol]++;
        return { holdings: [holding({ symbol, signal: 'TRIM' })] };
      },
    }, { now: () => clock, ttlMs: 1000 });
    const firstUser = serviceFor('ABC');
    const secondUser = serviceFor('XYZ');

    const first = await firstUser();
    const second = await secondUser();
    assert.equal(first.holdings[0].text, 'ABC: technical signal flipped HOLD → TRIM');
    assert.equal(second.holdings[0].text, 'XYZ: technical signal flipped HOLD → TRIM');
    assert.deepEqual(await firstUser(), { ...first, cached: true });
    assert.deepEqual(await secondUser(), { ...second, cached: true });
    assert.deepEqual(loads, { ABC: 1, XYZ: 1 });
  });
});
