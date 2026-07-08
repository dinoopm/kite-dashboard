// ─── Per-stock institutional activity (India) ────────────────────────────────
// Layers the three disclosure speeds India actually has: quarterly shareholding
// pattern (official positions), daily bulk/block deals, and daily delivery % —
// then reads them with fixed rules into one verdict. Same philosophy as
// redFlags.js: deterministic heuristics; each source degrades independently so a
// screener outage still returns deals + delivery.
//
// The US instrument page has its own equivalent in backend/alpaca.js
// (/api/us/holders/:symbol — Yahoo 13F data; the US has no delivery-% or
// bulk-deal-disclosure equivalents).
//
// `getQuarters(symbol)` is injected by server.js so this module reuses the
// screener.in fetch + parse + 12h cache that already back
// /api/screener-shareholding, instead of scraping twice.

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const iso = (off) => { const d = new Date(); d.setDate(d.getDate() - off); return d.toISOString().slice(0, 10); };
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r1 = (v) => (v == null || !isFinite(v) ? null : +v.toFixed(1));
const r2 = (v) => (v == null || !isFinite(v) ? null : +v.toFixed(2));

async function indiaInstitutional(symbol, { getQuarters }) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) throw new Error('symbol required');

  // Each source independently; one failing must not kill the panel.
  const [quartersR, dealsR, bhavR] = await Promise.allSettled([
    getQuarters(sym),
    supabase.from('large_deals').select('trade_date,deal_type,quantity,price,client_name').eq('symbol', sym).gte('trade_date', iso(90)).order('trade_date', { ascending: false }),
    supabase.from('nse_bhavcopy').select('trade_date,deliv_per').eq('symbol', sym).eq('series', 'EQ').order('trade_date', { ascending: false }).limit(20),
  ]);

  // ── Quarterly shareholding trend (last 8 quarters, oldest → newest) ──
  let quarters = null;
  if (quartersR.status === 'fulfilled' && Array.isArray(quartersR.value) && quartersR.value.length) {
    quarters = quartersR.value
      .slice()
      .sort((a, b) => (a.fy - b.fy) || (a.q - b.q))
      .slice(-8)
      .map(c => ({
        label: c.label,
        promoters: c.promoters ?? null,
        fiis: c.fiis ?? null,
        diis: c.diis ?? null,
        public: c.public ?? null,
      }));
  }

  // ── Bulk/block deals, last 90 days ──
  let deals = null;
  if (dealsR.status === 'fulfilled' && !dealsR.value.error) {
    const rows = dealsR.value.data || [];
    let buyVal = 0, sellVal = 0;
    const byClient = new Map();
    const list = rows.map(d => {
      const value = (d.quantity || 0) * (d.price || 0);
      if (d.deal_type === 'BUY') buyVal += value; else if (d.deal_type === 'SELL') sellVal += value;
      const name = d.client_name || '?';
      byClient.set(name, (byClient.get(name) || 0) + (d.deal_type === 'BUY' ? value : -value));
      return { date: d.trade_date, type: d.deal_type, client: d.client_name, qty: d.quantity, price: d.price, valueCr: r2(value / 1e7) };
    });
    const topParticipants = [...byClient.entries()]
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 5)
      .map(([client, net]) => ({ client, netCr: r2(net / 1e7) }));
    deals = {
      count: rows.length,
      buyCr: r2(buyVal / 1e7), sellCr: r2(sellVal / 1e7), netCr: r2((buyVal - sellVal) / 1e7),
      topParticipants,
      recent: list.slice(0, 15),
    };
  }

  // ── Delivery trend (rows newest-first): recent 5 vs prior 15 sessions ──
  let delivery = null;
  if (bhavR.status === 'fulfilled' && !bhavR.value.error && (bhavR.value.data || []).length >= 10) {
    const rows = bhavR.value.data;
    const recent = r1(mean(rows.slice(0, 5).map(r => r.deliv_per).filter(v => v != null)));
    const prior = r1(mean(rows.slice(5).map(r => r.deliv_per).filter(v => v != null)));
    delivery = { recentAvg: recent, priorAvg: prior, asOf: rows[0].trade_date };
  }

  // ── Verdict: fixed rules over whatever sources are available ──
  // Institutional QoQ = change in FII+DII combined % over the last 2 quarters.
  let instChange2Q = null, promoterChange2Q = null;
  if (quarters && quarters.length >= 3) {
    const at = (i, f) => quarters[quarters.length - 1 - i]?.[f];
    const inst = (i) => (at(i, 'fiis') != null || at(i, 'diis') != null) ? (at(i, 'fiis') || 0) + (at(i, 'diis') || 0) : null;
    if (inst(0) != null && inst(2) != null) instChange2Q = r2(inst(0) - inst(2));
    if (at(0, 'promoters') != null && at(2, 'promoters') != null) promoterChange2Q = r2(at(0, 'promoters') - at(2, 'promoters'));
  }
  const dealNet = deals?.netCr ?? null;
  const delivRising = delivery ? delivery.recentAvg > delivery.priorAvg * 1.1 : null;

  let verdict = { label: 'NO CLEAR FOOTPRINT', tone: 'neutral', detail: 'No decisive institutional pattern in the available data.' };
  if (instChange2Q != null && instChange2Q > 0.5 && ((dealNet != null && dealNet > 0) || delivRising === true)) {
    verdict = {
      label: 'ACCUMULATION FOOTPRINT', tone: 'good',
      detail: `FII+DII stake up ${instChange2Q} pp over the last 2 quarters${dealNet > 0 ? `, net bulk/block buying of ₹${dealNet} cr in 90 days` : ''}${delivRising ? `, delivery % rising (${delivery.priorAvg}% → ${delivery.recentAvg}%)` : ''} — institutions are adding.`,
    };
  } else if (instChange2Q != null && instChange2Q < -0.5 && (promoterChange2Q == null || promoterChange2Q <= 0)) {
    verdict = {
      label: 'DISTRIBUTION FOOTPRINT', tone: 'warn',
      detail: `FII+DII stake down ${Math.abs(instChange2Q)} pp over the last 2 quarters${promoterChange2Q != null && promoterChange2Q < -0.5 ? ` and promoters down ${Math.abs(promoterChange2Q)} pp` : ''}${dealNet != null && dealNet < 0 ? `, net bulk/block selling of ₹${Math.abs(dealNet)} cr in 90 days` : ''} — institutions are trimming.`,
    };
  } else if (promoterChange2Q != null && promoterChange2Q < -2) {
    verdict = {
      label: 'PROMOTER SELLING', tone: 'warn',
      detail: `Promoter stake down ${Math.abs(promoterChange2Q)} pp over the last 2 quarters — worth understanding why before adding.`,
    };
  }

  return {
    symbol: sym, market: 'IN',
    source: 'screener.in quarterly shareholding (≤12h) + NSE bulk/block deals & delivery % (daily EOD)',
    quarters, deals, delivery, instChange2Q, promoterChange2Q,
    verdict,
  };
}

module.exports = { indiaInstitutional };
