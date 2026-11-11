import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as defer } from 'node:timers/promises';
import { loadSectorComposite } from './sectorComposite.js';

const SECTOR = 'NSE:NIFTY CAPITAL GOODS';
const members = count => ({ constituents: Array.from({ length: count }, (_, index) => ({ token: String(index + 1) })) });
const candlePayload = { content: [{ text: JSON.stringify([{ date: '2026-10-30', close: 100 }]) }] };
const composite = { series: [{ date: '2026-10-30', close: 1200 }], lastClose: 1200, prevClose: 1190, constituentsUsed: 50, constituentsTotal: 50 };
const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status });

test('50 warm stocks require only a membership query, cache probe, and final calculation', async () => {
  const calls = [], progress = [];
  const result = await loadSectorComposite(SECTOR, {
    onProgress: value => progress.push(value),
    fetcher: async (url, options) => {
      calls.push(url);
      if (url.includes('/sector-constituents/')) return response(members(50));
      if (url.endsWith('/cached')) {
        assert.equal(options.method, 'POST');
        assert.equal(JSON.parse(options.body).tokens.length, 50);
        return response({ cachedTokens: members(50).constituents.map(row => row.token) });
      }
      assert.ok(url.endsWith(encodeURIComponent(SECTOR)));
      return response(composite);
    },
  });
  assert.deepEqual(result, composite);
  assert.equal(calls.length, 3);
  assert.deepEqual(progress, [
    { completed: 50, total: 50, phase: 'history' },
    { completed: 50, total: 50, phase: 'composite' },
  ]);
});

test('cold histories load with bounded concurrency and measurable progress before the composite', async () => {
  let active = 0, maxActive = 0, loaded = 0;
  const progress = [];
  await loadSectorComposite(SECTOR, {
    onProgress: value => progress.push(value.completed),
    fetcher: async (url, options) => {
      if (url.includes('/sector-constituents/')) return response(members(50));
      if (url.endsWith('/cached')) return response({ cachedTokens: ['1', '2', '3', '4', '5'] });
      if (url.includes('/sector-composite/')) {
        assert.equal(loaded, 45, 'The final request must not start a cold 50-stock build');
        return response(composite);
      }
      assert.equal(options.timeoutMs, 120_000);
      active++;
      maxActive = Math.max(maxActive, active);
      await defer();
      active--;
      loaded++;
      return response(candlePayload);
    },
  });
  assert.equal(maxActive, 3);
  assert.equal(progress[0], 5);
  assert.equal(progress.at(-1), 50);
  assert.ok(progress.every((value, index) => !index || value >= progress[index - 1]));
});

test('a failed stock is reported and a retry reuses successfully cached histories', async () => {
  let retry = false;
  const requested = [];
  const fetcher = async url => {
    if (url.includes('/sector-constituents/')) return response(members(3));
    if (url.endsWith('/cached')) return response({ cachedTokens: retry ? ['1', '3'] : [] });
    if (url.includes('/sector-composite/')) {
      assert.ok(retry, 'Do not calculate a row after a constituent history failed');
      return response(composite);
    }
    requested.push(url.split('/').at(-1));
    return response(!retry && url.endsWith('/2') ? { content: [{ text: '[]' }] } : candlePayload);
  };
  await assert.rejects(loadSectorComposite(SECTOR, { fetcher }), /1 of 3 stock histories could not load/);
  retry = true;
  requested.length = 0;
  await loadSectorComposite(SECTOR, { fetcher });
  assert.deepEqual(requested, ['2']);
});

test('an unavailable cache probe falls back to normal history requests', async () => {
  let historyCalls = 0;
  await loadSectorComposite(SECTOR, { fetcher: async url => {
    if (url.includes('/sector-constituents/')) return response(members(2));
    if (url.endsWith('/cached')) return response({ error: 'Unavailable' }, 500);
    if (url.includes('/sector-composite/')) return response(composite);
    historyCalls++;
    return response(candlePayload);
  } });
  assert.equal(historyCalls, 2);
});

test('leaving the page stops progress and prevents the final request', async () => {
  const controller = new AbortController();
  let finalCalls = 0, callbacksAfterAbort = 0;
  await assert.rejects(loadSectorComposite(SECTOR, {
    signal: controller.signal,
    onProgress: progress => {
      if (controller.signal.aborted) callbacksAfterAbort++;
      if (progress.completed === 1) controller.abort();
    },
    fetcher: async url => {
      if (url.includes('/sector-constituents/')) return response(members(50));
      if (url.endsWith('/cached')) return response({ cachedTokens: [] });
      if (url.includes('/sector-composite/')) finalCalls++;
      await defer();
      return response(candlePayload);
    },
  }), { name: 'AbortError' });
  await defer();
  assert.equal(finalCalls, 0);
  assert.equal(callbacksAfterAbort, 0);
});

test('a known upstream failure is surfaced instead of leaving a zero row', async () => {
  await assert.rejects(loadSectorComposite(SECTOR, {
    fetcher: async () => response({ error: 'No constituents available' }, 404),
  }), /No constituents available/);
});

test('an empty final series is an actionable error', async () => {
  await assert.rejects(loadSectorComposite(SECTOR, { fetcher: async url => {
    if (url.includes('/sector-constituents/')) return response(members(1));
    if (url.endsWith('/cached')) return response({ cachedTokens: ['1'] });
    return response({ series: [], lastClose: null });
  } }), /Composite price history is unavailable/);
});

test('duplicate and missing tokens do not inflate progress or duplicate requests', async () => {
  let progressTotal;
  await loadSectorComposite(SECTOR, {
    onProgress: progress => { progressTotal = progress.total; },
    fetcher: async url => {
      if (url.includes('/sector-constituents/')) return response({ constituents: [{ token: '1' }, { token: 1 }, { token: null }] });
      if (url.endsWith('/cached')) return response({ cachedTokens: ['1', '999'] });
      return response(composite);
    },
  });
  assert.equal(progressTotal, 1);
});
