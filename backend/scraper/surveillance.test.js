const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { readReport, normalizeSurveillanceStocks, syncSurveillance } = require('./surveillance');

const ASM = /\/api\/report-?asm/i;

// A puppeteer Response is a live handle onto a browser target. Once that target
// goes away — the browser closed, NSE aborted the request, the response was a
// redirect — the ACCESSORS throw, not just the body read. url() and status()
// sat outside the json() try/catch, so the async handler's promise rejected
// with nothing awaiting it, and Node kills the process on an unhandled
// rejection with exit code 1.
//
// That is what failed the workflow on 2026-07-04, 07-18 and 08-08: the run died
// mid-retry (32s, when the retry path alone sleeps 40s) instead of finishing
// with "no stocks found" and exiting 0. The retry loop never got the chance,
// because the rejection was not on the chain it was awaiting.
const fake = ({ url = 'https://www.nseindia.com/api/reportASM', status = 200, json, throwOn = null }) => ({
  url: () => { if (throwOn === 'url') throw new Error('Protocol error: Target closed'); return url; },
  status: () => { if (throwOn === 'status') throw new Error('Protocol error: Target closed'); return status; },
  json: async () => { if (throwOn === 'json') throw new Error('Response body is unavailable'); return json; },
});

describe('readReport', () => {
  test('returns the parsed body for a matching 200', async () => {
    const body = { longterm: { data: [{ symbol: 'X' }] } };
    assert.deepEqual(await readReport(fake({ json: body }), ASM), body);
  });

  test('ignores a response for a different endpoint', async () => {
    assert.equal(await readReport(fake({ url: 'https://www.nseindia.com/api/marketStatus', json: {} }), ASM), null);
  });

  test('ignores a non-200, which is what a block looks like', async () => {
    assert.equal(await readReport(fake({ status: 403, json: {} }), ASM), null);
  });

  // The three ways a detached target bites. Each one used to take the whole
  // process down; none may now.
  for (const stage of ['url', 'status', 'json']) {
    test(`survives ${stage}() throwing on a detached target`, async () => {
      assert.equal(await readReport(fake({ throwOn: stage }), ASM), null);
    });
  }

  test('never rejects, whatever it is handed', async () => {
    await assert.doesNotReject(() => readReport(null, ASM));
    await assert.doesNotReject(() => readReport(undefined, ASM));
    await assert.doesNotReject(() => readReport({}, ASM));
  });

  test('treats a body that is not JSON as no data rather than an error', async () => {
    assert.equal(await readReport(fake({ json: undefined }), ASM), null);
  });
});

describe('isCompleteScrape', () => {
  const { isCompleteScrape } = require('./surveillance');
  const asm = { symbol: 'A', measure: 'ASM', stage: 'Stage I' };
  const gsm = { symbol: 'B', measure: 'GSM', stage: '1' };

  test('both measures present is complete', () => {
    assert.equal(isCompleteScrape([asm, gsm]), true);
  });

  // picks/engine.js hard-excludes every symbol in this table. A run
  // where NSE served ASM but blocked GSM would wipe 82 GSM names and let them
  // straight back into the published picks — silently, and now that the job no
  // longer dies on a block, it would report success while doing it.
  test('one measure missing is not complete, however many rows it has', () => {
    assert.equal(isCompleteScrape(Array.from({ length: 193 }, () => asm)), false);
    assert.equal(isCompleteScrape([gsm]), false);
  });

  test('an empty scrape is not complete', () => {
    assert.equal(isCompleteScrape([]), false);
    assert.equal(isCompleteScrape(null), false);
    assert.equal(isCompleteScrape({ length: 2 }), false);
    assert.equal(isCompleteScrape([null]), false);
  });
});

const row = (symbol, measure = 'ASM', stage = '1') => ({ symbol, measure, stage });
const quiet = { log() {}, warn() {} };

// In-memory Supabase double: enforces the same unique-symbol constraint as
// Postgres and records ordering. No broker, NSE, or database access is needed.
function fakeStore(initialRows = [], { uploadErrorAt, readErrorAt, malformedPageAt, deleteErrorAt } = {}) {
  const rows = new Map(initialRows.map(stock => [stock.symbol, { ...stock }]));
  const calls = [];
  let uploads = 0;
  let reads = 0;
  let deletes = 0;
  const client = {
    from(table) {
      assert.equal(table, 'surveillance_stocks');
      return {
        async upsert(batch, options) {
          calls.push({ type: 'upsert', batch });
          assert.deepEqual(options, { onConflict: 'symbol' });
          assert.ok(batch.length <= 100);
          assert.equal(new Set(batch.map(stock => stock.symbol)).size, batch.length,
            'ON CONFLICT DO UPDATE command cannot affect row a second time');
          if (++uploads === uploadErrorAt) return { error: { message: 'upload failed' } };
          batch.forEach(stock => rows.set(stock.symbol, { ...stock }));
          return { error: null };
        },
        select(columns) {
          assert.equal(columns, 'symbol');
          return {
            order(column, options) {
              assert.equal(column, 'symbol');
              assert.deepEqual(options, { ascending: true });
              return {
                async range(from, to) {
                  calls.push({ type: 'select', from, to });
                  if (++reads === readErrorAt) return { error: { message: 'read failed' } };
                  if (reads === malformedPageAt) return { data: null, error: null };
                  const data = [...rows.keys()].sort().slice(from, to + 1).map(symbol => ({ symbol }));
                  return { data, error: null };
                },
              };
            },
          };
        },
        delete() {
          return {
            async in(column, symbols) {
              assert.equal(column, 'symbol');
              assert.ok(symbols.length <= 100);
              calls.push({ type: 'delete', symbols });
              if (++deletes === deleteErrorAt) return { error: { message: 'delete failed' } };
              symbols.forEach(symbol => rows.delete(symbol));
              return { error: null };
            },
          };
        },
      };
    },
  };
  return { client, calls, rows };
}

const sync = (store, stocks) => syncSurveillance({ client: store.client, scrape: async () => stocks, logger: quiet });

describe('normalizeSurveillanceStocks', () => {
  test('normalizes symbols and stages, keeping the last report row for duplicates', () => {
    assert.deepEqual(normalizeSurveillanceStocks([
      row(' abc ', 'ASM', ' Stage I '), row('XYZ', 'ASM', ''), row('AbC', 'GSM', 2),
    ]), [row('ABC', 'GSM', '2'), row('XYZ', 'ASM', 'Unknown')]);
  });

  test('does not mutate source rows', () => {
    const stock = Object.freeze(row(' abc '));
    assert.deepEqual(normalizeSurveillanceStocks(Object.freeze([stock])), [row('ABC')]);
    assert.equal(stock.symbol, ' abc ');
  });

  test('rejects malformed input instead of silently dropping exclusions', () => {
    for (const stocks of [null, {}, [null], [row('')], [row(123)], [row('ABC', 'OTHER')]]) {
      assert.throws(() => normalizeSurveillanceStocks(stocks), /Surveillance response|Invalid surveillance row/);
    }
  });
});

describe('syncSurveillance', () => {
  test('deduplicates within and across batch boundaries before uploading', async () => {
    const stocks = [row('DUP'), row(' dup ', 'ASM', '2'),
      ...Array.from({ length: 105 }, (_, index) => row(`S${index}`)), row('Dup', 'GSM', '3')];
    const store = fakeStore([row('OLD'), row('old-case')]);
    await sync(store, stocks);
    assert.equal(store.rows.size, 106);
    assert.deepEqual(store.rows.get('DUP'), row('DUP', 'GSM', '3'));
    const batches = store.calls.filter(call => call.type === 'upsert');
    assert.deepEqual(batches.map(call => call.batch.length), [100, 6]);
    assert.equal(batches.flatMap(call => call.batch).filter(stock => stock.symbol === 'DUP').length, 1);
    assert.deepEqual(store.calls.map(call => call.type), ['upsert', 'upsert', 'select', 'delete']);
    assert.deepEqual(store.calls.at(-1).symbols, ['OLD', 'old-case']);
  });

  test('checks both source reports before collapsing an overlapping symbol', async () => {
    const store = fakeStore();
    await sync(store, [row('ABC'), row('ABC', 'GSM')]);
    assert.deepEqual([...store.rows.values()], [row('ABC', 'GSM')]);
  });

  test('preserves existing rows for empty or partial reports without database calls', async () => {
    for (const stocks of [[], [row('NEW')], [row('NEW', 'GSM')]]) {
      const store = fakeStore([row('OLD')]);
      await sync(store, stocks);
      assert.deepEqual(store.calls, []);
      assert.ok(store.rows.has('OLD'));
    }
  });

  test('rejects malformed rows before making database calls', async () => {
    for (const stocks of [null, {}, [row('NEW'), row('GSM', 'GSM'), null]]) {
      const store = fakeStore([row('OLD')]);
      await assert.rejects(sync(store, stocks), /Surveillance response|Invalid surveillance row/);
      assert.deepEqual(store.calls, []);
    }
  });

  test('does not prune on scraper failure', async () => {
    const store = fakeStore([row('OLD')]);
    await assert.rejects(syncSurveillance({ client: store.client, logger: quiet,
      scrape: async () => { throw new Error('NSE unavailable'); } }), /NSE unavailable/);
    assert.deepEqual(store.calls, []);
  });

  for (const uploadErrorAt of [1, 2]) {
    test(`preserves every old symbol when upload batch ${uploadErrorAt} fails`, async () => {
      const store = fakeStore([row('OLD')], { uploadErrorAt });
      const stocks = [...Array.from({ length: 101 }, (_, index) => row(`S${index}`)), row('GSM', 'GSM')];
      await assert.rejects(sync(store, stocks), /Supabase Insert Error: upload failed/);
      assert.ok(store.rows.has('OLD'));
      assert.ok(store.calls.every(call => call.type === 'upsert'));
    });
  }

  test('reads all sorted pages before pruning stale symbols in bounded batches', async () => {
    const store = fakeStore(Array.from({ length: 1005 }, (_, index) => row(`OLD${index}`)));
    await sync(store, [row('ABC'), row('GSM', 'GSM')]);
    assert.deepEqual([...store.rows.keys()].sort(), ['ABC', 'GSM']);
    assert.deepEqual(store.calls.filter(call => call.type === 'select').map(({ from, to }) => [from, to]),
      [[0, 999], [1000, 1999]]);
    const firstDelete = store.calls.findIndex(call => call.type === 'delete');
    assert.equal(firstDelete, 3);
    assert.equal(store.calls.filter(call => call.type === 'delete').length, 11);
  });

  for (const readErrorAt of [1, 2]) {
    test(`preserves stale rows when symbol page ${readErrorAt} fails`, async () => {
      const store = fakeStore(Array.from({ length: 1005 }, (_, index) => row(`OLD${index}`)), { readErrorAt });
      await assert.rejects(sync(store, [row('ABC'), row('GSM', 'GSM')]), /Supabase Read Error: read failed/);
      assert.equal(store.rows.size, 1007);
      assert.ok(!store.calls.some(call => call.type === 'delete'));
    });
  }

  test('does not prune when stored symbols are malformed', async () => {
    const store = fakeStore([row('OLD')], { malformedPageAt: 1 });
    await assert.rejects(sync(store, [row('ABC'), row('GSM', 'GSM')]), /Invalid stored surveillance symbols/);
    assert.ok(store.rows.has('OLD'));
    assert.ok(!store.calls.some(call => call.type === 'delete'));
  });

  test('skips deletion when no stale symbols remain', async () => {
    const store = fakeStore([row('ABC'), row('GSM', 'GSM')]);
    await sync(store, [row('ABC'), row('GSM', 'GSM')]);
    assert.deepEqual(store.calls.map(call => call.type), ['upsert', 'select']);
  });

  test('reports pruning failures while retaining the uploaded list', async () => {
    const store = fakeStore([row('OLD')], { deleteErrorAt: 1 });
    await assert.rejects(sync(store, [row('ABC'), row('GSM', 'GSM')]), /Supabase Delete Error: delete failed/);
    assert.ok(store.rows.has('ABC'));
    assert.ok(store.rows.has('GSM'));
    assert.ok(store.rows.has('OLD'));
  });
});
