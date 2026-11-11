const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildTranslator, adaptResult } = require('./kiteTools');

// The selectors and values below are Kite's own, from the tool list its hosted
// MCP returned after sign-in on 2026-11-10 (saved to
// data/kite-sessions/kite-mcp-tools.json). Every grouped tool takes `mode`.
const tool = (name, modes) => ({ name, inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: modes } }, required: ['mode'] } });
const KITE = [
  tool('alerts', ['get', 'create', 'modify', 'delete']),
  tool('gtt', ['list', 'place', 'modify', 'delete']),
  { name: 'help', inputSchema: { type: 'object', properties: { key: { type: 'string' } } } },
  tool('market', ['quote', 'ltp', 'ohlc', 'historical', 'search', 'option_chain']),
  tool('mutual_funds', ['holdings']),
  tool('orders', ['list', 'history', 'trades', 'all_trades', 'place', 'modify', 'cancel', 'approval_status', 'permissions']),
  tool('portfolio', ['profile', 'margins', 'holdings', 'positions']),
  tool('session', ['status', 'logout']),
];
const translate = buildTranslator(KITE);
const as = (name, args = {}) => translate({ name, arguments: args });

test('the profile is under portfolio, not session', () => {
  assert.deepEqual(as('get_profile'), { name: 'portfolio', arguments: { mode: 'profile' } });
});

test('each old read call lands on its group and mode', () => {
  assert.deepEqual(as('get_margins'), { name: 'portfolio', arguments: { mode: 'margins' } });
  assert.deepEqual(as('get_holdings'), { name: 'portfolio', arguments: { mode: 'holdings' } });
  assert.deepEqual(as('get_positions'), { name: 'portfolio', arguments: { mode: 'positions' } });
  assert.deepEqual(as('get_mf_holdings'), { name: 'mutual_funds', arguments: { mode: 'holdings' } });
  assert.deepEqual(as('get_quotes', { instruments: ['NSE:INFY'] }), { name: 'market', arguments: { instruments: ['NSE:INFY'], mode: 'quote' } });
  assert.equal(as('get_historical_data', { instrument_token: 1 }).arguments.mode, 'historical');
  assert.deepEqual(as('search_instruments', { query: 'NSE:INFY', filter_on: 'id', limit: 20 }),
    { name: 'market', arguments: { query: 'NSE:INFY', filter_on: 'id', limit: 20, mode: 'search' } });
});

// mode=trades is the fills for ONE order and needs an order_id; the old
// get_trades was every trade today, which is all_trades.
test('trades today are all_trades, never the per-order trades mode', () => {
  assert.deepEqual(as('get_trades'), { name: 'orders', arguments: { mode: 'all_trades' } });
});

test('nothing reaches a placing, changing or cancelling mode', () => {
  for (const name of ['place_order', 'modify_order', 'cancel_order', 'place_gtt_order', 'delete_gtt_order']) {
    assert.deepEqual(as(name, { x: 1 }), { name, arguments: { x: 1 } });
  }
});

test('login has no grouped equivalent and passes through', () => {
  assert.deepEqual(as('login'), { name: 'login', arguments: {} });
});

test('a name the server still offers passes through untouched', () => {
  const t = buildTranslator([...KITE, { name: 'get_holdings', inputSchema: { type: 'object' } }]);
  assert.deepEqual(t({ name: 'get_holdings', arguments: {} }), { name: 'get_holdings', arguments: {} });
});

test('a selector pinned by const in oneOf variants is found too', () => {
  const t = buildTranslator([{ name: 'portfolio', inputSchema: { oneOf: [
    { properties: { mode: { const: 'profile' } } }, { properties: { mode: { const: 'holdings' } } },
  ] } }]);
  assert.equal(t({ name: 'get_profile', arguments: {} }).arguments.mode, 'profile');
});

test('an empty or missing tool list translates nothing', () => {
  assert.deepEqual(buildTranslator(null)({ name: 'get_profile', arguments: {} }), { name: 'get_profile', arguments: {} });
});

// ─── Responses ───────────────────────────────────────────────────────────────
// Holdings, positions and trades now come back as pages of 100 wrapped in
// data/pagination. The old calls returned everything, bare.
const reply = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const body = (result) => JSON.parse(result.content[0].text);

test('every page is collected and the data returned bare', async () => {
  const rows = Array.from({ length: 230 }, (_, i) => ({ tradingsymbol: `S${i}` }));
  const asked = [];
  const fetchPage = async (from) => {
    asked.push(from);
    const page = rows.slice(from, from + 100);
    return reply({ data: page, pagination: { from, limit: 100, total: 230, has_more: from + page.length < 230 } });
  };
  const first = await fetchPage(0);
  const out = await adaptResult({ name: 'get_holdings', arguments: {} }, first, fetchPage);
  assert.equal(body(out).length, 230);
  assert.deepEqual(asked, [0, 100, 200]);
});

test('a caller that asked for a page keeps the paginated shape', async () => {
  const first = reply({ data: [{ id: 'NSE:INFY' }], pagination: { has_more: true } });
  const out = await adaptResult({ name: 'search_instruments', arguments: { limit: 20 } }, first, async () => { throw new Error('must not page'); });
  assert.deepEqual(body(out), { data: [{ id: 'NSE:INFY' }], pagination: { has_more: true } });
});

test('positions are regrouped into the old net and day lists', async () => {
  const first = reply({ data: [{ tradingsymbol: 'A', view: 'net' }, { tradingsymbol: 'A', view: 'day' }, { tradingsymbol: 'B', view: 'net' }], pagination: { has_more: false } });
  const out = await adaptResult({ name: 'get_positions', arguments: {} }, first, async () => null);
  assert.deepEqual(body(out), {
    net: [{ tradingsymbol: 'A', view: 'net' }, { tradingsymbol: 'B', view: 'net' }],
    day: [{ tradingsymbol: 'A', view: 'day' }],
  });
});

test('a data/meta reply such as quotes is unwrapped to its data', async () => {
  const first = reply({ data: { 'NSE:INFY': { last_price: 1500 } }, meta: { missing_instruments: [] } });
  const out = await adaptResult({ name: 'get_quotes', arguments: { instruments: ['NSE:INFY'] } }, first, async () => null);
  assert.deepEqual(body(out), { 'NSE:INFY': { last_price: 1500 } });
});

test('errors, prose and replies without data pass through unchanged', async () => {
  const error = { isError: true, content: [{ type: 'text', text: '{"data":1}' }] };
  assert.equal(await adaptResult({ name: 'get_profile', arguments: {} }, error, null), error);
  const prose = { content: [{ type: 'text', text: 'Session expired' }] };
  assert.equal(await adaptResult({ name: 'get_profile', arguments: {} }, prose, null), prose);
  const profile = reply({ user_id: 'AB1234' });
  assert.equal(await adaptResult({ name: 'get_profile', arguments: {} }, profile, null), profile);
});

// Kite Connect's own REST API sends candles as rows of numbers under
// data.candles; the old MCP sent objects. The page reads objects with .date.
test('history sent as rows of numbers becomes candle objects', async () => {
  const first = reply({ data: { candles: [['2026-11-09T00:00:00+0530', 100, 110, 95, 105, 1234]] } });
  const out = await adaptResult({ name: 'get_historical_data', arguments: {} }, first, null);
  assert.deepEqual(body(out), [{ date: '2026-11-09T00:00:00+0530', open: 100, high: 110, low: 95, close: 105, volume: 1234 }]);
});

test('bare candle rows without a data wrapper are converted too', async () => {
  const out = await adaptResult({ name: 'get_historical_data', arguments: {} }, reply([['2026-11-09', 1, 2, 0.5, 1.5, 10]]), null);
  assert.deepEqual(body(out), [{ date: '2026-11-09', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]);
});

test('history objects keyed by timestamp get a date', async () => {
  const first = reply({ data: [{ timestamp: '2026-11-09T00:00:00+0530', close: 105 }] });
  const out = await adaptResult({ name: 'get_historical_data', arguments: {} }, first, null);
  assert.equal(body(out)[0].date, '2026-11-09T00:00:00+0530');
});

// The basket's 1D is last price over quote.ohlc.close; with ohlc missing it
// read 0.00% for every stock.
test('a quote with its OHLC flattened gets the ohlc object back', async () => {
  const first = reply({ data: { 'NSE:ABB': { last_price: 6915, open: 6800, high: 6950, low: 6780, close: 6850 } } });
  const out = await adaptResult({ name: 'get_quotes', arguments: {} }, first, null);
  assert.deepEqual(body(out)['NSE:ABB'].ohlc, { open: 6800, high: 6950, low: 6780, close: 6850 });
});

test('a quote that already has ohlc is left alone', async () => {
  const q = { last_price: 1, ohlc: { open: 1, high: 1, low: 1, close: 1 }, close: 9 };
  const out = await adaptResult({ name: 'get_quotes', arguments: {} }, reply({ data: { 'NSE:X': q } }), null);
  assert.deepEqual(body(out)['NSE:X'], q);
});

test('paging stops on an empty page rather than looping', async () => {
  let calls = 0;
  const first = reply({ data: [{ a: 1 }], pagination: { has_more: true } });
  const out = await adaptResult({ name: 'get_trades', arguments: {} }, first, async () => { calls++; return reply({ data: [], pagination: { has_more: true } }); });
  assert.equal(body(out).length, 1);
  assert.equal(calls, 1);
});

// ─── Samples ─────────────────────────────────────────────────────────────────
const { sampleOf } = require('./kiteTools');

test('market replies are kept as text; they are public prices', () => {
  const s = sampleOf({ name: 'get_quotes', arguments: { instruments: ['NSE:ABB'] } },
    { name: 'market', arguments: { instruments: ['NSE:ABB'], mode: 'quote' } },
    reply({ data: { 'NSE:ABB': { last_price: 6915 } } }));
  assert.equal(s.call, 'get_quotes');
  assert.match(s.text, /6915/);
  assert.deepEqual(s.sent, { name: 'market', arguments: { instruments: ['NSE:ABB'], mode: 'quote' } });
});

test('account replies keep field names and types only, never values', () => {
  const s = sampleOf({ name: 'get_profile', arguments: {} }, { name: 'portfolio', arguments: { mode: 'profile' } },
    reply({ data: { user_id: 'AB1234', email: 'someone@example.com', exchanges: ['NSE'] } }));
  assert.equal(s.text, undefined);
  assert.deepEqual(s.shape, { data: { user_id: 'string', email: 'string', exchanges: ['string'] } });
  assert.doesNotMatch(JSON.stringify(s), /AB1234|someone/);
});

test('an error reply is sampled with its message', () => {
  const s = sampleOf({ name: 'get_historical_data', arguments: {} }, { name: 'market', arguments: {} },
    { isError: true, content: [{ type: 'text', text: 'interval not allowed' }] });
  assert.equal(s.isError, true);
  assert.equal(s.text, 'interval not allowed');
});
