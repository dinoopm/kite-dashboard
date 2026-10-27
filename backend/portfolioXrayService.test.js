const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPortfolioXrayService } = require('./portfolioXrayService');

const holding = { tradingsymbol: 'TEST', instrument_token: 123, quantity: 1 };
const payload = { holdings: [{ symbol: 'TEST', token: 123, badges: [], score: 0 }], summary: { total: 1 } };

test('loads X-Ray in process with PORT=0 and no loopback HTTP fetch', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Loopback fetch must not be used'); });
  const previousPort = process.env.PORT;
  process.env.PORT = '0';
  t.after(() => {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  });
  let loads = 0;
  let analyses = 0;
  const getXray = createPortfolioXrayService({
    isConnected: () => true,
    loadHoldings: async () => { loads++; return [holding]; },
    analyze: async rows => { analyses++; assert.deepEqual(rows, [holding]); return payload; },
  });
  assert.deepEqual(await getXray(), payload);
  assert.deepEqual(await getXray(), { ...payload, cached: true });
  assert.equal(loads, 1);
  assert.equal(analyses, 1);
});

test('coalesces concurrent Briefing and Portfolio requests into one analysis', async () => {
  let finish;
  const ready = new Promise(resolve => { finish = resolve; });
  let loads = 0;
  let analyses = 0;
  const getXray = createPortfolioXrayService({
    isConnected: () => true,
    loadHoldings: async () => { loads++; await ready; return [holding]; },
    analyze: async () => { analyses++; return payload; },
  });
  const requests = [getXray(), getXray(), getXray()];
  finish();
  assert.deepEqual(await Promise.all(requests), [payload, payload, payload]);
  assert.equal(loads, 1);
  assert.equal(analyses, 1);
});

test('disconnected sessions cannot read cached holdings', async () => {
  let connected = true;
  const getXray = createPortfolioXrayService({
    isConnected: () => connected,
    loadHoldings: async () => [holding], analyze: async () => payload,
  });
  await getXray();
  connected = false;
  await assert.rejects(getXray(), /MCP not connected/);
});

test('expired cache is recalculated', async () => {
  let clock = 0;
  let loads = 0;
  const getXray = createPortfolioXrayService({
    isConnected: () => true, now: () => clock, ttlMs: 10,
    loadHoldings: async () => { loads++; return [holding]; }, analyze: async () => payload,
  });
  await getXray();
  clock = 9;
  assert.equal((await getXray()).cached, true);
  clock = 10;
  assert.equal((await getXray()).cached, undefined);
  assert.equal(loads, 2);
});

test('failed loads and analyses clear in-flight state for the next retry', async () => {
  for (const failure of ['load', 'analysis']) {
    let attempts = 0;
    const getXray = createPortfolioXrayService({
      isConnected: () => true,
      loadHoldings: async () => {
        if (failure === 'load' && ++attempts === 1) throw new Error('Kite unavailable');
        return [holding];
      },
      analyze: async () => {
        if (failure === 'analysis' && ++attempts === 1) throw new Error('Analysis unavailable');
        return payload;
      },
    });
    await assert.rejects(getXray(), /unavailable/);
    assert.deepEqual(await getXray(), payload);
    assert.equal((await getXray()).cached, true);
  }
});

test('malformed holdings fail without being treated as an empty portfolio', async () => {
  let holdings = { error: 'upstream failed' };
  const getXray = createPortfolioXrayService({
    isConnected: () => true,
    loadHoldings: async () => holdings,
    analyze: async () => { throw new Error('Invalid holdings must not reach analysis'); },
  });
  await assert.rejects(getXray(), /Invalid Kite holdings response/);
  holdings = [];
  assert.deepEqual(await getXray(), { holdings: [], summary: { total: 0, flagged: 0, clean: 0, worstThree: [] } });
});

test('separate session services keep holdings and caches isolated', async () => {
  const create = symbol => createPortfolioXrayService({
    isConnected: () => true,
    loadHoldings: async () => [{ tradingsymbol: symbol }],
    analyze: async rows => ({ holdings: rows }),
  });
  const alice = create('ALICE');
  const bob = create('BOB');
  await Promise.all([alice(), bob()]);
  assert.equal((await alice()).holdings[0].tradingsymbol, 'ALICE');
  assert.equal((await bob()).holdings[0].tradingsymbol, 'BOB');
});
