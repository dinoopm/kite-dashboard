// ─── Kite's grouped MCP tools ────────────────────────────────────────────────
//
// On 2026-11-10 the hosted server at mcp.kite.trade moved to OAuth and replaced
// its one-tool-per-call list (get_profile, get_holdings, get_quotes, …) with
// eight grouped tools — alerts, gtt, help, market, mutual_funds, orders,
// portfolio, session — each taking a `mode`. Every call this backend made
// failed with "unknown tool".
//
// Rather than rewrite a dozen call sites, each old call is translated at the
// one place calls leave the process: the old name becomes its group, plus that
// group's selector set to the matching value. The selector and its values are
// read from the server's own schema at runtime; the table below only says
// which values mean the same thing as each old call. It was written against
// the schema Kite returned on 2026-11-10 (data/kite-sessions/kite-mcp-tools.json).
//
// Only the read calls this backend makes are listed. Nothing here can reach an
// order, GTT or alert mutation: those names are not in the table, so they pass
// through untouched and fail as they would have. Note orders mode=trades is
// the fills for ONE order; the old get_trades (every trade today) is
// all_trades, and 'trades' is deliberately not a candidate.

const LEGACY = {
  get_profile: { groups: ['portfolio', 'session'], actions: ['profile', 'get_profile'] },
  get_margins: { groups: ['portfolio', 'session'], actions: ['margins', 'get_margins'] },
  get_holdings: { groups: ['portfolio'], actions: ['holdings', 'get_holdings'] },
  get_positions: { groups: ['portfolio'], actions: ['positions', 'get_positions'] },
  get_trades: { groups: ['orders'], actions: ['all_trades', 'get_trades'] },
  get_mf_holdings: { groups: ['mutual_funds'], actions: ['holdings', 'mf_holdings', 'get_mf_holdings'] },
  get_quotes: { groups: ['market'], actions: ['quote', 'quotes', 'get_quotes'] },
  get_historical_data: { groups: ['market'], actions: ['historical', 'historical_data', 'get_historical_data'] },
  search_instruments: { groups: ['market'], actions: ['search', 'search_instruments'] },
};

/**
 * Every string value a tool's schema allows for each property: from an enum,
 * or from const pins across oneOf/anyOf variants. { property: Set(values) }.
 */
function choices(schema) {
  const out = {};
  const add = (prop, values) => { (out[prop] ||= new Set()); for (const v of values) if (typeof v === 'string') out[prop].add(v); };
  const visit = (s) => {
    if (!s || typeof s !== 'object') return;
    for (const [prop, def] of Object.entries(s.properties || {})) {
      if (Array.isArray(def?.enum)) add(prop, def.enum);
      if (typeof def?.const === 'string') add(prop, [def.const]);
    }
    for (const variant of [...(s.oneOf || []), ...(s.anyOf || []), ...(s.allOf || [])]) visit(variant);
  };
  visit(schema);
  return out;
}

/** A function that rewrites an old-style call for the server's current tools. */
function buildTranslator(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const offered = new Set(list.map(t => t.name));
  const byName = new Map(list.map(t => [t.name, t]));
  return function translate(call) {
    if (!call?.name || offered.has(call.name)) return call;
    const legacy = LEGACY[call.name];
    if (!legacy) return call;
    for (const group of legacy.groups) {
      const tool = byName.get(group);
      if (!tool) continue;
      for (const [prop, values] of Object.entries(choices(tool.inputSchema))) {
        const action = legacy.actions.find(a => values.has(a));
        if (action) return { ...call, name: group, arguments: { ...(call.arguments || {}), [prop]: action } };
      }
    }
    return call;
  };
}

// ─── Responses ───────────────────────────────────────────────────────────────
//
// The grouped tools wrap their answers: lists come back as data/pagination in
// pages of 100 (holdings, positions, trades, search), quotes as data/meta, and
// positions as one list whose rows say view=day or view=net. The old calls
// returned everything, bare — holdings as an array, positions as {net, day},
// quotes keyed by instrument. Every caller here was written for that.
//
// A caller that passed `limit` was already asking for a page (instrument
// search does, and reads .data), so its reply is left exactly as it came.

const MAX_PAGES = 50; // 50 × 500 rows; a loop guard, not a real limit

const parse = (result) => {
  if (!result || result.isError) return null;
  const text = result.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return null; }
};
const hasMore = (p, have) => p?.has_more === true || p?.hasMore === true
  || (Number.isFinite(p?.total) && have < p.total);

/**
 * The reply an old-style caller expects. `fetchPage(from)` re-asks the same
 * grouped call starting at row `from` and resolves to its raw result.
 */
async function adaptResult(call, result, fetchPage) {
  const parsed = parse(result);
  if (!parsed || typeof parsed !== 'object') return result;
  const wrapped = !Array.isArray(parsed) && 'data' in parsed;
  // History may also come bare (rows of numbers, or {candles}); everything
  // else unwrapped is already in the old shape.
  if (!wrapped && call?.name !== 'get_historical_data') return result;
  if (wrapped && call?.arguments && 'limit' in call.arguments) return result;
  let data = wrapped ? parsed.data : parsed;
  if (wrapped && Array.isArray(data) && parsed.pagination && fetchPage) {
    let pagination = parsed.pagination;
    for (let pages = 1; hasMore(pagination, data.length) && pages < MAX_PAGES; pages++) {
      const next = parse(await fetchPage(data.length));
      if (!Array.isArray(next?.data) || next.data.length === 0) break;
      data = data.concat(next.data);
      pagination = next.pagination;
    }
  }
  if (call?.name === 'get_positions' && Array.isArray(data) && data.some(r => r?.view)) {
    data = { net: data.filter(r => r.view === 'net'), day: data.filter(r => r.view === 'day') };
  }
  if (call?.name === 'get_historical_data') data = candles(data);
  if (call?.name === 'get_quotes') data = withOhlc(data);
  return { ...result, content: [{ type: 'text', text: JSON.stringify(data) }] };
}

// Kite Connect's REST API sends candles as [date, open, high, low, close,
// volume, oi?] under data.candles; the old MCP sent objects with .date, which
// is what every history consumer here reads.
const CANDLE = ['date', 'open', 'high', 'low', 'close', 'volume', 'oi'];
function candles(data) {
  const rows = Array.isArray(data?.candles) ? data.candles : data;
  if (!Array.isArray(rows)) return data;
  return rows.map(r => {
    if (Array.isArray(r)) return Object.fromEntries(r.map((v, i) => [CANDLE[i], v]).filter(([k]) => k));
    if (r && typeof r === 'object' && r.date == null && (r.timestamp ?? r.time) != null) return { ...r, date: r.timestamp ?? r.time };
    return r;
  });
}

// The basket's 1D is last price over quote.ohlc.close (yesterday's close).
function withOhlc(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const out = {};
  for (const [key, q] of Object.entries(data)) {
    const flat = q && typeof q === 'object' && !q.ohlc && ['open', 'high', 'low', 'close'].some(k => typeof q[k] === 'number');
    out[key] = flat ? { ...q, ohlc: { open: q.open, high: q.high, low: q.low, close: q.close } } : q;
  }
  return out;
}

// ─── Samples ─────────────────────────────────────────────────────────────────
//
// The tool schemas say what goes in, not what comes back, and the worker's
// output is discarded, so a reply in an unexpected shape fails silently. These
// samples are the evidence. Market data is public prices, kept as text. Every
// other reply is reduced to field names and types: no account value is kept.

const MARKET_CALLS = new Set(['get_quotes', 'get_historical_data', 'search_instruments']);
const TEXT_LIMIT = 4000;

function shapeOf(value, depth = 0) {
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0], depth + 1)] : [];
  if (value && typeof value === 'object') {
    if (depth > 3) return 'object';
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shapeOf(v, depth + 1)]));
  }
  return value === null ? 'null' : typeof value;
}

function sampleOf(call, sent, result) {
  const text = result?.content?.[0]?.text;
  const base = { call: call?.name, sent: { name: sent?.name, arguments: sent?.arguments }, isError: Boolean(result?.isError), at: new Date().toISOString() };
  if (MARKET_CALLS.has(call?.name) || result?.isError) return { ...base, text: typeof text === 'string' ? text.slice(0, TEXT_LIMIT) : null };
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { ...base, sent: { name: sent?.name, mode: sent?.arguments?.mode }, shape: parsed == null ? typeof text : shapeOf(parsed) };
}

module.exports = { buildTranslator, adaptResult, sampleOf, LEGACY };
