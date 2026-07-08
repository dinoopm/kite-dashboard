// ─── Trade-journal engine ────────────────────────────────────────────────────
// Turns raw fills (trade_log rows) into round trips and performance stats.
//
// Round-trip definition: FIFO within one flat-to-flat position cycle. Buys
// open/extend a cycle; when cumulative sells bring the position back to zero,
// the cycle closes as one round trip (entryAvg = qty-weighted buy price,
// exitAvg = qty-weighted sell price). A cycle still open at the end is an
// open position, reported separately with its remaining FIFO cost.
//
// Sells that exceed the held quantity (stock bought before the backfill
// window, or a short) can't be attributed an entry price — those fills are
// counted in `unmatched` and excluded from stats rather than guessed at.

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const r2 = (v) => (v == null || !isFinite(v) ? null : +v.toFixed(2));
const day = (ts) => String(ts).slice(0, 10);
const daysBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000));

function buildRoundTrips(fills) {
  // fills: ascending by trade_ts, single symbol
  const trips = [];
  let lots = [];               // open FIFO lots: { qty, price, ts }
  let cyc = null;              // current cycle accumulators
  let unmatchedSellQty = 0;

  const startCycle = (f) => { cyc = { buyQty: 0, buyVal: 0, sellQty: 0, sellVal: 0, firstTs: f.trade_ts, lastTs: f.trade_ts }; };

  for (const f of fills) {
    const qty = Number(f.qty), price = Number(f.price);
    if (!(qty > 0) || !(price > 0)) continue;
    if (f.side === 'BUY') {
      if (!cyc) startCycle(f);
      lots.push({ qty, price, ts: f.trade_ts });
      cyc.buyQty += qty; cyc.buyVal += qty * price; cyc.lastTs = f.trade_ts;
    } else if (f.side === 'SELL') {
      let remaining = qty;
      while (remaining > 0 && lots.length) {
        const lot = lots[0];
        const take = Math.min(lot.qty, remaining);
        lot.qty -= take; remaining -= take;
        cyc.sellQty += take; cyc.sellVal += take * price; cyc.lastTs = f.trade_ts;
        if (lot.qty === 0) lots.shift();
      }
      if (remaining > 0) unmatchedSellQty += remaining;
      if (cyc && lots.length === 0 && cyc.sellQty > 0) {
        // flat again — close the cycle
        const entryAvg = cyc.buyVal / cyc.buyQty;
        const exitAvg = cyc.sellVal / cyc.sellQty;
        trips.push({
          entryDate: day(cyc.firstTs), exitDate: day(f.trade_ts),
          qty: cyc.sellQty,
          entryAvg: r2(entryAvg), exitAvg: r2(exitAvg),
          pnl: r2(cyc.sellVal - (entryAvg * cyc.sellQty)),
          pnlPct: r2(((exitAvg / entryAvg) - 1) * 100),
          holdingDays: daysBetween(cyc.firstTs, f.trade_ts),
        });
        cyc = null;
      }
    }
  }

  let open = null;
  if (lots.length) {
    const qty = lots.reduce((s, l) => s + l.qty, 0);
    const val = lots.reduce((s, l) => s + l.qty * l.price, 0);
    open = { qty, avgPrice: r2(val / qty), since: day(lots[0].ts) };
  }
  return { trips, open, unmatchedSellQty };
}

// Optional { from, to } (YYYY-MM-DD) restricts the REPORTED round trips by
// exit date. Reconstruction always runs over all fills — filtering fills
// before FIFO would orphan sells whose buys predate the range.
async function journalStats({ from, to } = {}) {
  const { data: fills, error } = await supabase
    .from('trade_log').select('symbol,side,qty,price,trade_ts')
    .order('trade_ts', { ascending: true })
    .limit(20000);
  if (error) throw new Error(error.message);
  if (!fills?.length) return { empty: true, fills: 0 };

  const bySymbol = new Map();
  for (const f of fills) {
    if (!bySymbol.has(f.symbol)) bySymbol.set(f.symbol, []);
    bySymbol.get(f.symbol).push(f);
  }

  let trips = [];
  const openPositions = [];
  let unmatched = 0;
  for (const [symbol, sfills] of bySymbol) {
    const r = buildRoundTrips(sfills);
    trips.push(...r.trips.map(t => ({ symbol, ...t })));
    if (r.open) openPositions.push({ symbol, ...r.open });
    unmatched += r.unmatchedSellQty;
  }
  const allTrips = trips.length;
  if (from) trips = trips.filter(t => t.exitDate >= from);
  if (to) trips = trips.filter(t => t.exitDate <= to);
  trips.sort((a, b) => (a.exitDate < b.exitDate ? 1 : -1));

  // Factor tag: was the symbol a quant pick on (or within 5 days before) entry?
  const symbols = [...new Set(trips.map(t => t.symbol))];
  const pickSet = new Set();
  if (symbols.length) {
    const { data: picks } = await supabase
      .from('stock_pick_snapshots').select('snap_date,symbol').in('symbol', symbols).limit(10000);
    for (const p of picks || []) pickSet.add(`${p.symbol}|${p.snap_date}`);
  }
  for (const t of trips) {
    t.wasPick = false;
    for (let off = 0; off <= 5 && !t.wasPick; off++) {
      const d = new Date(t.entryDate); d.setDate(d.getDate() - off);
      if (pickSet.has(`${t.symbol}|${d.toISOString().slice(0, 10)}`)) t.wasPick = true;
    }
  }

  const wins = trips.filter(t => t.pnl > 0), losses = trips.filter(t => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const holdSorted = trips.map(t => t.holdingDays).sort((a, b) => a - b);
  const monthly = {};
  for (const t of trips) {
    const m = t.exitDate.slice(0, 7);
    monthly[m] = r2((monthly[m] || 0) + t.pnl);
  }

  return {
    fills: fills.length,
    trades: trips.length,
    allTrades: allTrips,
    range: (from || to) ? { from: from || null, to: to || null } : null,
    stats: trips.length ? {
      winRate: r2((wins.length / trips.length) * 100),
      avgWinPct: wins.length ? r2(wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length) : null,
      avgLossPct: losses.length ? r2(losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length) : null,
      expectancyPct: r2(trips.reduce((s, t) => s + t.pnlPct, 0) / trips.length),
      profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
      totalPnl: r2(grossWin - grossLoss),
      medianHoldingDays: holdSorted.length ? holdSorted[Math.floor(holdSorted.length / 2)] : null,
      best: trips.reduce((m, t) => (t.pnl > (m?.pnl ?? -Infinity) ? t : m), null),
      worst: trips.reduce((m, t) => (t.pnl < (m?.pnl ?? Infinity) ? t : m), null),
      pickTrades: trips.filter(t => t.wasPick).length,
      pickWinRate: (() => { const p = trips.filter(t => t.wasPick); return p.length ? r2((p.filter(t => t.pnl > 0).length / p.length) * 100) : null; })(),
    } : null,
    monthly: Object.entries(monthly).sort(([a], [b]) => a.localeCompare(b)).map(([month, pnl]) => ({ month, pnl })),
    trips: trips.slice(0, 200),
    openPositions,
    unmatchedSellQty: unmatched,
  };
}

module.exports = { journalStats, buildRoundTrips };
