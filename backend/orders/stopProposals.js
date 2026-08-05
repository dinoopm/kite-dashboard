// ─── Protective-stop proposals ───────────────────────────────────────────────
//
// Computes a stop level for each holding and records it. Nothing here contacts
// the broker: this module only ever writes to Supabase. Placement lives in
// orders/place.js behind an explicit human click.
//
// The rule is not a guess. stopStudy.js replayed all 49 closed round trips
// under ten candidates; a 4x ATR(14) trail was the best of them, turning an
// actual -Rs 2,92,442 into roughly breakeven, and cutting the fewest winners
// short of any rule that caught the catastrophic losses. See RULE below.
//
// Every proposal is validated before it is offered, and a REJECTED proposal is
// still written down. A log that only records what was placed cannot answer
// "why was there no stop on that position?", which is the only question that
// matters after a loss.

const { createClient } = require('@supabase/supabase-js');
const { stopSeries } = require('../stopStudy');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// The winner of the Phase-0 sweep. Named and versioned so a proposal can always
// be traced back to the rule that produced it, and so changing the rule is a
// visible act rather than a quiet edit to a number.
const RULE = { name: 'atr-trail-4.0x', kind: 'atr', mult: 4 };

// Safety envelope. These reject rather than clamp: a stop that has to be
// clamped to be sane is a stop whose inputs are wrong, and silently moving it
// would hide that.
const LIMITS = {
  maxLossPct: 25,      // a stop implying a worse loss than this is not protection
  minDistancePct: 0.5, // closer than this to spot and ordinary noise fills it
  minBars: 40,         // ATR(14) plus room for the trail to mean something
};

const r2 = (v) => (v == null || !isFinite(v) ? null : +v.toFixed(2));

/**
 * The trailing stop level for a position held from `sinceDate`.
 *
 * Ratchets: takes the highest level the rule has produced since entry, so the
 * stop only ever tightens. A protective stop that loosens as price falls is not
 * protecting anything.
 *
 * When the entry date is unknown, the trail starts from the beginning of the
 * supplied bars — the caller decides how much history to pass, which keeps this
 * function free of any opinion about lookback.
 */
function trailingStop(bars, sinceDate = null) {
  if (!Array.isArray(bars) || bars.length < LIMITS.minBars) return null;
  const series = stopSeries(bars, RULE);
  const startIdx = sinceDate ? bars.findIndex(b => b.date >= sinceDate) : 0;
  if (startIdx < 0) return null;

  let trail = null;
  for (let i = Math.max(0, startIdx); i < bars.length; i++) {
    const lvl = series[i];
    if (lvl != null && (trail == null || lvl > trail)) trail = lvl;
  }
  return trail;
}

/**
 * Turn one holding into a proposal, or into a recorded rejection.
 *
 * @param holding { symbol, exchange, instrument_token, quantity, last_price, average_price }
 * @param bars    daily bars, oldest first, ending at the latest session
 * @param opts    { sinceDate, limits }
 */
function computeStopProposal(holding, bars, { sinceDate = null, limits = LIMITS } = {}) {
  const base = {
    symbol: holding.symbol,
    exchange: (holding.exchange || 'NSE').toUpperCase(),
    instrument_token: holding.instrument_token ?? null,
    quantity: Number(holding.quantity) || 0,
    last_price: r2(holding.last_price),
    avg_price: r2(holding.average_price),
    rule: RULE.name,
  };

  const reject = (reason) => ({ ...base, status: 'rejected', reject_reason: reason, trigger_price: null, worst_case_loss: null });

  if (!(base.quantity > 0)) return reject('no quantity held');
  if (!Number.isFinite(base.last_price) || base.last_price <= 0) return reject('no usable last price');
  if (!Array.isArray(bars) || bars.length < limits.minBars) {
    return reject(`only ${bars?.length ?? 0} bars of history, need ${limits.minBars}`);
  }

  const trigger = trailingStop(bars, sinceDate);
  if (trigger == null) return reject('stop rule produced no level');

  // A trail computed on a position that has fallen a long way can sit ABOVE
  // spot. That is not a stop, it is a market sell — refuse and say so, rather
  // than quietly placing an order that executes immediately.
  if (trigger >= base.last_price) {
    return reject(`stop ${r2(trigger)} is at or above last price ${base.last_price} — the position is already below its trail`);
  }

  const distancePct = ((base.last_price - trigger) / base.last_price) * 100;
  if (distancePct < limits.minDistancePct) {
    return reject(`stop is ${r2(distancePct)}% from spot, inside normal noise`);
  }

  const worstCaseLoss = (trigger - base.last_price) * base.quantity;
  const lossPct = Math.abs((trigger - base.last_price) / base.last_price) * 100;
  if (lossPct > limits.maxLossPct) {
    return reject(`stop implies a ${r2(lossPct)}% fall, beyond the ${limits.maxLossPct}% cap`);
  }

  return {
    ...base,
    status: 'proposed',
    reject_reason: null,
    trigger_price: r2(trigger),
    worst_case_loss: r2(worstCaseLoss),
    distance_pct: r2(distancePct),
  };
}

/**
 * Persist a day's proposals. Upsert on (proposed_on, symbol, exchange) so the
 * daily job refreshes rather than accumulating duplicates.
 *
 * Rows already marked `placed` are left alone: once a GTT exists at the broker,
 * the proposal that produced it is history and must not be overwritten by a
 * fresh computation.
 */
async function saveProposals(rows, proposedOn) {
  if (!rows.length) return { saved: 0, skippedPlaced: 0 };

  const { data: existing } = await supabase.from('stop_proposals')
    .select('symbol,exchange,status').eq('proposed_on', proposedOn);
  const placed = new Set((existing || [])
    .filter(r => r.status === 'placed' || r.status === 'triggered')
    .map(r => `${r.exchange}:${r.symbol}`));

  const writable = rows.filter(r => !placed.has(`${r.exchange}:${r.symbol}`));
  if (writable.length) {
    const { error } = await supabase.from('stop_proposals')
      .upsert(writable.map(r => ({ ...r, proposed_on: proposedOn })), { onConflict: 'proposed_on,symbol,exchange' });
    if (error) throw new Error(`stop_proposals: ${error.message}`);
  }
  return { saved: writable.length, skippedPlaced: rows.length - writable.length };
}

/**
 * Build proposals for every holding.
 *
 * Holdings and bars are injected: holdings come from the Kite MCP client that
 * lives in server.js, and bar fetching is shared with stopStudy. Keeping both
 * out of this module is what lets the computation be tested without a network.
 *
 * @param fetchHoldings () => holdings[]  (Kite shape)
 * @param fetchBars     (symbol, exchange) => bars[]
 * @param sinceBySymbol optional map symbol -> entry date, from the journal
 */
async function buildProposals({ fetchHoldings, fetchBars, sinceBySymbol = {}, proposedOn = null } = {}) {
  const day = proposedOn || new Date().toISOString().slice(0, 10);
  const holdings = await fetchHoldings();
  const rows = [];

  for (const h of holdings || []) {
    // Use the exchange and token Kite reports. Rebuilding `NSE:${symbol}` is
    // what priced a BSE holding off NSE's book and reported +6.69% against the
    // broker's +3.53%.
    const symbol = h.tradingsymbol || h.symbol;
    const exchange = (h.exchange || 'NSE').toUpperCase();
    let bars = null;
    try {
      bars = await fetchBars(symbol, exchange);
    } catch { /* recorded as a rejection below */ }

    rows.push(computeStopProposal({
      symbol, exchange,
      instrument_token: h.instrument_token,
      quantity: h.quantity,
      last_price: h.last_price,
      average_price: h.average_price,
    }, bars, { sinceDate: sinceBySymbol[symbol] || null }));
  }

  const persisted = await saveProposals(rows, day);
  return {
    proposedOn: day,
    rule: RULE.name,
    holdings: holdings?.length || 0,
    proposed: rows.filter(r => r.status === 'proposed').length,
    rejected: rows.filter(r => r.status === 'rejected').length,
    ...persisted,
    rows,
  };
}

/** Today's proposals, newest day first. Read-only. */
async function listProposals({ on = null, limit = 200 } = {}) {
  let q = supabase.from('stop_proposals').select('*').order('proposed_on', { ascending: false }).limit(limit);
  if (on) q = q.eq('proposed_on', on);
  const { data, error } = await q;
  if (error) throw new Error(`stop_proposals: ${error.message}`);
  return data || [];
}

module.exports = {
  buildProposals, listProposals, saveProposals,
  computeStopProposal, trailingStop, RULE, LIMITS,
};
