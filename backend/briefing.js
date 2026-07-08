// ─── Morning Briefing ────────────────────────────────────────────────────────
// One composed read of "what changed since yesterday", from data the app
// already collects: market-wide FII/DII flows + India VIX, per-holding
// analytic deltas (vs holding_state_snapshots — new red flags, signal flips,
// verdict changes), and quant-picks churn (stock_pick_snapshots). All items
// are deterministic { text, tone, link } — no LLM.
//
// Dependencies injected by server.js: getQuotes(instruments) → Kite quotes
// map, and getXray() → the /api/portfolio/xray payload (cached there).

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const today = () => new Date().toISOString().slice(0, 10);
// "(today)" / "(tomorrow)" / "(in N days)" for a YYYY-MM-DD date.
const daysLeft = (dateStr) => {
  const d = Math.ceil((new Date(dateStr + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
};
const cr = (v) => `${v >= 0 ? '+' : '−'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')} cr`;

async function marketItems(getQuotes) {
  const items = [];
  try {
    const { data } = await supabase.from('fii_dii_activity').select('*').order('trade_date', { ascending: false }).limit(5);
    if (data?.length) {
      const [latest] = data;
      const fii5 = data.reduce((s, r) => s + (r.fii_net || 0), 0);
      const dii5 = data.reduce((s, r) => s + (r.dii_net || 0), 0);
      items.push({
        tone: latest.fii_net >= 0 ? 'good' : 'warn',
        text: `FII ${cr(latest.fii_net)}, DII ${cr(latest.dii_net)} in cash market on ${latest.trade_date} (5 sessions: FII ${cr(fii5)}, DII ${cr(dii5)}).`,
        link: '/market-data/fii-dii',
      });
    }
  } catch { /* section optional */ }
  // US macro events in the next 7 days (macro_events, seeded annually) —
  // FOMC/CPI days move every market, India included.
  try {
    const t = new Date(); t.setDate(t.getDate() + 7);
    const { data } = await supabase.from('macro_events')
      .select('event_date,title').gte('event_date', today()).lte('event_date', t.toISOString().slice(0, 10))
      .order('event_date', { ascending: true }).limit(6);
    for (const e of data || []) {
      const big = /FOMC|Fed Meeting|CPI/.test(e.title);
      items.push({
        tone: big ? 'warn' : 'neutral',
        text: `US macro: ${e.title} on ${e.event_date} (${daysLeft(e.event_date)})${big ? ' — expect bigger swings globally' : ''}`,
        link: '/market-data/events',
      });
    }
  } catch { /* section optional */ }
  try {
    const quotes = await getQuotes(['NSE:INDIA VIX', 'NSE:NIFTY 50']);
    const vix = quotes?.['NSE:INDIA VIX'];
    if (vix?.last_price) {
      const lvl = vix.last_price;
      const chg = vix.ohlc?.close ? ((lvl - vix.ohlc.close) / vix.ohlc.close) * 100 : null;
      items.push({
        tone: lvl >= 20 ? 'warn' : lvl < 13 ? 'good' : 'neutral',
        text: `India VIX ${lvl.toFixed(2)}${chg != null ? ` (${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% vs prev close)` : ''} — ${lvl >= 20 ? 'elevated; markets pricing bigger swings' : lvl < 13 ? 'calm regime' : 'normal range'}.`,
        link: '/vix',
      });
    }
  } catch { /* section optional */ }
  return items;
}

// Compare today's x-ray state per holding with the last stored snapshot and
// write today's snapshot (idempotent upsert). First-ever run has no baseline,
// so it just seeds and reports nothing — deltas start tomorrow.
async function holdingItems(getXray) {
  const xray = await getXray();
  const rows = xray?.holdings || [];
  if (!rows.length) return [];

  const { data: prevRows } = await supabase
    .from('holding_state_snapshots').select('*')
    .lt('snap_date', today())
    .order('snap_date', { ascending: false })
    .limit(rows.length * 5);
  const prevBySymbol = new Map();
  for (const r of prevRows || []) if (!prevBySymbol.has(r.symbol)) prevBySymbol.set(r.symbol, r);

  const items = [];
  for (const h of rows) {
    const prev = prevBySymbol.get(h.symbol);
    if (!prev) continue; // new holding or first run — nothing to diff against
    const prevBadges = new Set((prev.badge_ids || '').split(',').filter(Boolean));
    for (const b of h.badges) {
      if (b.tone === 'good' || prevBadges.has(b.id)) continue;
      items.push({
        tone: b.tone,
        text: `${h.symbol}: new — ${b.label}${b.detail ? ` (${b.detail})` : ''}`,
        link: `/instrument/${h.token}?symbol=${encodeURIComponent(h.symbol)}`,
      });
    }
    if (h.signal && h.signal !== prev.signal && ['AVOID', 'SELL (AT RANGE)', 'TRIM', 'BEARISH'].includes(h.signal)) {
      items.push({
        tone: 'warn',
        text: `${h.symbol}: technical signal flipped ${prev.signal || '—'} → ${h.signal}`,
        link: `/instrument/${h.token}?symbol=${encodeURIComponent(h.symbol)}`,
      });
    }
  }

  const snap = rows.map(h => ({
    snap_date: today(), symbol: h.symbol, score: h.score,
    badge_ids: h.badges.map(b => b.id).join(','), signal: h.signal || null,
  }));
  await supabase.from('holding_state_snapshots').upsert(snap, { onConflict: 'snap_date,symbol' });

  return items;
}

async function pickItems() {
  const items = [];
  try {
    const { data: dates } = await supabase
      .from('stock_pick_snapshots').select('snap_date').order('snap_date', { ascending: false }).limit(200);
    const uniq = [...new Set((dates || []).map(d => d.snap_date))].slice(0, 2);
    if (uniq.length === 2) {
      const [latest, prev] = uniq;
      const [a, b] = await Promise.all([
        supabase.from('stock_pick_snapshots').select('symbol').eq('snap_date', latest),
        supabase.from('stock_pick_snapshots').select('symbol').eq('snap_date', prev),
      ]);
      const cur = new Set((a.data || []).map(r => r.symbol));
      const old = new Set((b.data || []).map(r => r.symbol));
      const entered = [...cur].filter(s => !old.has(s));
      const exited = [...old].filter(s => !cur.has(s));
      if (entered.length) items.push({ tone: 'good', text: `Entered Quant Picks (${latest}): ${entered.join(', ')}`, link: '/market-data/stock-picks' });
      if (exited.length) items.push({ tone: 'neutral', text: `Dropped out of Quant Picks: ${exited.join(', ')}`, link: '/market-data/stock-picks' });
    }
  } catch { /* section optional */ }
  return items;
}

// Upcoming corporate events (next 10 days) on symbols the user has a stake
// in: actual holdings, plus everything they follow — basket/theme instruments
// and virtual-portfolio holdings. Each item says WHY it's relevant
// ("holding" beats "watching · <list name>" when a symbol is in both).
async function eventItems(getEvents, getXray) {
  if (!getEvents) return [];
  try {
    const [rows, xray, themeItems, themes, pfItems, pfs] = await Promise.all([
      getEvents(),
      getXray(),
      supabase.from('theme_instruments').select('symbol,theme_id'),
      supabase.from('themes').select('id,name'),
      supabase.from('portfolio_holdings').select('symbol,portfolio_id'),
      supabase.from('portfolios').select('id,name'),
    ]);

    // symbol -> reason label, holdings taking precedence over watchlists
    const why = new Map();
    const themeName = new Map((themes.data || []).map(t => [t.id, t.name]));
    for (const r of themeItems.data || []) if (!why.has(r.symbol)) why.set(r.symbol, `watching · ${themeName.get(r.theme_id) || 'basket'}`);
    const pfName = new Map((pfs.data || []).map(p => [p.id, p.name]));
    for (const r of pfItems.data || []) if (!why.has(r.symbol)) why.set(r.symbol, `watching · ${pfName.get(r.portfolio_id) || 'virtual portfolio'}`);
    for (const h of xray?.holdings || []) why.set(h.symbol, 'holding');
    if (!why.size) return [];

    const t = today();
    const horizon = new Date(); horizon.setDate(horizon.getDate() + 10);
    const hz = horizon.toISOString().slice(0, 10);
    const relevant = rows
      .filter(e => why.has(e.symbol) && e.date >= t && e.date <= hz)
      .sort((a, b) => {
        const ah = why.get(a.symbol) === 'holding', bh = why.get(b.symbol) === 'holding';
        return (bh - ah) || a.date.localeCompare(b.date);
      })
      .map(e => ({
        tone: why.get(e.symbol) === 'holding' ? 'warn' : 'neutral',
        text: `${e.symbol}: ${e.purpose} ${daysLeft(e.date)} — ${e.date} (${why.get(e.symbol)})`,
        link: `/instrument/0?symbol=${encodeURIComponent(e.symbol)}`,
      }));

    // Watchlists can be entire index baskets (NIFTY 50, smallcap 250…), which
    // would flood the briefing. Holdings events always show; watching events
    // cap at 10 with a pointer to the full Events page.
    const holdingsEv = relevant.filter(e => e.tone === 'warn');
    const watchingEv = relevant.filter(e => e.tone === 'neutral');
    const out = [...holdingsEv, ...watchingEv.slice(0, 10)];
    if (watchingEv.length > 10) {
      out.push({ tone: 'neutral', text: `…and ${watchingEv.length - 10} more on watched stocks — full list on the Events page`, link: '/market-data/events' });
    }
    return out;
  } catch { return []; }
}

async function composeBriefing({ getQuotes, getXray, getEvents }) {
  const [market, holdings, picks, events] = await Promise.all([
    marketItems(getQuotes),
    holdingItems(getXray).catch(e => [{ tone: 'neutral', text: `Holdings deltas unavailable: ${e.message}`, link: '/portfolio' }]),
    pickItems(),
    eventItems(getEvents, getXray),
  ]);
  return {
    date: today(),
    market, holdings, picks, events,
    quiet: market.length + holdings.length + picks.length + events.length === 0,
  };
}

module.exports = { composeBriefing };
