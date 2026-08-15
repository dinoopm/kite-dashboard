const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { readReport } = require('./surveillance');

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

  // The hazard the crash used to mask. syncSurveillance DELETES the table and
  // re-inserts, and picks/engine.js hard-excludes every symbol in it. A run
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
  });
});

// The 2026-08-15 failure. The scrape was clean — 140 long-term ASM, 70
// short-term ASM, 82 GSM — and the upsert died on "ON CONFLICT DO UPDATE
// command cannot affect row a second time", because at least one name was on
// two of those lists and `surveillance_stocks` is keyed on symbol alone.
// Postgres rejects a statement that touches the same conflict key twice, and
// the DELETE had already run, so the exclusion list was left empty.
describe('dedupeBySymbol', () => {
  const { dedupeBySymbol } = require('./surveillance');
  const symbols = (rows) => rows.map(r => r.symbol);

  test('leaves a list that is already unique alone', () => {
    const rows = [
      { symbol: 'A', measure: 'ASM', stage: 'Stage I' },
      { symbol: 'B', measure: 'GSM', stage: '2' },
    ];
    assert.deepEqual(dedupeBySymbol(rows), rows);
  });

  // NSE publishes long-term and short-term ASM as separate lists and a stock
  // can be on both, so this is normal input rather than a scrape fault.
  test('collapses a symbol that is on both ASM lists', () => {
    const out = dedupeBySymbol([
      { symbol: 'A', measure: 'ASM', stage: 'Stage I' },
      { symbol: 'A', measure: 'ASM', stage: 'Stage II' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].stage, 'Stage I');   // tie → first seen, so it is deterministic
  });

  // GSM restricts trading outright; ASM only raises margins. When a name is
  // under both, GSM is the fact worth printing — and it must win from either
  // input order, since only one row survives.
  test('keeps GSM over ASM whichever came first', () => {
    for (const rows of [
      [{ symbol: 'A', measure: 'ASM', stage: 'Stage I' }, { symbol: 'A', measure: 'GSM', stage: '2' }],
      [{ symbol: 'A', measure: 'GSM', stage: '2' }, { symbol: 'A', measure: 'ASM', stage: 'Stage I' }],
    ]) {
      const out = dedupeBySymbol(rows);
      assert.equal(out.length, 1);
      assert.deepEqual(out[0], { symbol: 'A', measure: 'GSM', stage: '2' });
    }
  });

  test('prefers a named stage over Unknown within a measure', () => {
    const out = dedupeBySymbol([
      { symbol: 'A', measure: 'ASM', stage: 'Unknown' },
      { symbol: 'A', measure: 'ASM', stage: 'Stage II' },
    ]);
    assert.deepEqual(out, [{ symbol: 'A', measure: 'ASM', stage: 'Stage II' }]);
  });

  // A measure outranks a stage: an unknown-stage GSM still beats a fully
  // labelled ASM, because the regime is the more restrictive one.
  test('measure outranks stage detail', () => {
    const out = dedupeBySymbol([
      { symbol: 'A', measure: 'ASM', stage: 'Stage I' },
      { symbol: 'A', measure: 'GSM', stage: 'Unknown' },
    ]);
    assert.equal(out[0].measure, 'GSM');
  });

  // What the upsert actually needs: no conflict key appears twice, in any batch.
  test('output has no repeated symbol, and keeps every distinct one', () => {
    const rows = [
      { symbol: 'A', measure: 'ASM', stage: 'Stage I' },
      { symbol: 'B', measure: 'ASM', stage: 'Stage I' },
      { symbol: 'A', measure: 'ASM', stage: 'Stage II' },
      { symbol: 'C', measure: 'GSM', stage: '1' },
      { symbol: 'B', measure: 'GSM', stage: '4' },
    ];
    const out = dedupeBySymbol(rows);
    assert.equal(new Set(symbols(out)).size, out.length);
    assert.deepEqual(symbols(out).sort(), ['A', 'B', 'C']);
  });

  test('survives an empty or missing list', () => {
    assert.deepEqual(dedupeBySymbol([]), []);
    assert.deepEqual(dedupeBySymbol(null), []);
  });
});
