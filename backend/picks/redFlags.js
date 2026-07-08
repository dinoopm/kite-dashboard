// ─── Symbol-scoped manipulation red flags (India) ────────────────────────────
// The same deterministic guards the picks engine runs universe-wide
// (surveillance, deal conviction, delivery conviction, volume authenticity),
// recomputed from a handful of single-symbol Supabase queries so the
// instrument page can show them per stock, fast.
//
// The US instrument page has its own equivalent in backend/alpaca.js
// (/api/us/red-flags/:symbol) — different data source (Alpaca daily bars;
// the US has no delivery-% or bulk-deal-disclosure equivalents), same
// response shape: { flags: [{ id, severity, title, detail }], source, asOf }.

const { createClient } = require('@supabase/supabase-js');
const { hvSpike } = require('../volMath');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const iso = (off) => { const d = new Date(); d.setDate(d.getDate() - off); return d.toISOString().slice(0, 10); };
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r1 = (v) => (v == null || !isFinite(v) ? null : +v.toFixed(1));

async function indiaRedFlags(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) throw new Error('symbol required');

  const [surv, deals, bhav, vg, gl, hist] = await Promise.all([
    supabase.from('surveillance_stocks').select('measure,stage').eq('symbol', sym),
    supabase.from('large_deals').select('deal_type,quantity,price,client_name').eq('symbol', sym).gte('trade_date', iso(90)),
    supabase.from('nse_bhavcopy').select('trade_date,close,high,prev_close,deliv_per,turnover_lacs').eq('symbol', sym).eq('series', 'EQ').order('trade_date', { ascending: false }).limit(20),
    supabase.from('volume_gainers').select('week1_vol_change,pct_change').eq('symbol', sym).gte('trade_date', iso(30)),
    supabase.from('top_gainers_losers').select('category').eq('symbol', sym).gte('trade_date', iso(30)),
    // ~1.5y of closes for the volatility-spike check (rolling 20D HV percentile)
    supabase.from('nse_bhavcopy').select('trade_date,close').eq('symbol', sym).eq('series', 'EQ').order('trade_date', { ascending: false }).limit(400),
  ]);
  for (const q of [surv, deals, bhav, vg, gl, hist]) if (q.error) throw new Error(q.error.message);

  const flags = [];

  // 1) NSE surveillance (ASM/GSM)
  if (surv.data?.length) {
    const s = surv.data[0];
    flags.push({
      id: 'surveillance', severity: 'red',
      title: `Under NSE surveillance (${s.measure || 'ASM'}${s.stage ? `, stage ${s.stage}` : ''})`,
      detail: 'The exchange has this stock under enhanced monitoring, usually after abnormal price/volume behaviour. Hard-excluded from Quant Picks.',
    });
  }

  // 2) Bulk/block-deal wash churn (deal conviction, 90d)
  let buyVal = 0, sellVal = 0;
  const clientNet = new Map();
  for (const d of deals.data || []) {
    const val = (d.quantity || 0) * (d.price || 0);
    const name = d.client_name || '?';
    if (d.deal_type === 'BUY') { buyVal += val; clientNet.set(name, (clientNet.get(name) || 0) + val); }
    else if (d.deal_type === 'SELL') { sellVal += val; clientNet.set(name, (clientNet.get(name) || 0) - val); }
  }
  const gross = buyVal + sellVal;
  const net = buyVal - sellVal;
  const netRatio = gross ? Math.abs(net) / gross : 0;
  // Relative-size guard: two-way block flow is routine for liquid large caps
  // (RELIANCE would flag on absolute thresholds). Churn is only suspicious
  // when the deal gross dwarfs the stock's normal trading — ≥3 days' worth of
  // its average turnover. No turnover data (thin/unlisted series) = keep flag.
  const avgTurnRs = (() => {
    const t = (bhav.data || []).map(r => r.turnover_lacs).filter(v => v != null);
    return t.length ? mean(t) * 1e5 : null;
  })();
  const grossVsDaily = avgTurnRs ? gross / avgTurnRs : null;
  if (gross > 25e7 && netRatio < 0.15 && (grossVsDaily == null || grossVsDaily > 3)) {
    const flat = [...clientNet.values()].filter(v => Math.abs(v) < 1e6).length;
    flags.push({
      id: 'deal-churn', severity: 'red',
      title: 'Bulk-deal wash churn — "institutional buying" is likely fake',
      detail: `₹${r1(gross / 1e7)} cr traded both ways in bulk/block deals over 90 days${grossVsDaily ? ` (≈${Math.round(grossVsDaily)} days of normal turnover)` : ''} but net only ₹${r1(net / 1e7)} cr (${r1(netRatio * 100)}% conviction)${flat ? `; ${flat} participant(s) bought & sold ~flat` : ''}. Prop/HFT round-tripping, not accumulation.`,
    });
  }

  // 3) Delivery layer (bhavcopy, last 20 sessions; rows newest-first)
  const rows = bhav.data || [];
  if (rows.length >= 5) {
    const avgDeliv = r1(mean(rows.map(r => r.deliv_per).filter(v => v != null)));
    const recent = r1(mean(rows.slice(0, 5).map(r => r.deliv_per).filter(v => v != null)));
    const prior = r1(mean(rows.slice(5).map(r => r.deliv_per).filter(v => v != null)));
    const avgTurn = mean(rows.map(r => r.turnover_lacs).filter(v => v != null));
    const circuitDays = rows.slice(0, 15).filter(r =>
      r.high > 0 && r.close >= r.high * 0.999 && r.prev_close > 0 && (r.close - r.prev_close) / r.prev_close >= 0.045).length;
    const priceRun = (rows[rows.length - 1].close > 0) ? rows[0].close / rows[rows.length - 1].close - 1 : null;

    if (circuitDays >= 3 && avgTurn != null && avgTurn < 1000) {
      flags.push({
        id: 'circuit-ladder', severity: 'red',
        title: 'Circuit-ladder ramp — locked at the upper band on thin turnover',
        detail: `${circuitDays} of the last 15 sessions closed locked at the upper price band with only ~₹${r1(avgTurn / 100)} cr/day traded. Classic low-float FOMO setup: you can't buy until the operators sell to you.`,
      });
    }
    if (rows.length >= 15 && priceRun != null && priceRun >= 0.15 && prior >= 10 && recent != null && recent < prior * 0.7) {
      flags.push({
        id: 'distribution', severity: 'amber',
        title: 'Distribution — price rising while delivery % falls',
        detail: `Price +${r1(priceRun * 100)}% over ~20 sessions while delivery fell ${prior}% → ${recent}% of traded volume. Buyers aren't keeping shares; rallies like this are often being sold into.`,
      });
    }
    if (avgDeliv != null && avgDeliv < 15 && avgTurn != null && avgTurn > 100) {
      flags.push({
        id: 'low-delivery', severity: 'amber',
        title: `Chronic low delivery (avg ${avgDeliv}%)`,
        detail: 'Most traded volume is squared off intraday — activity is churn/speculation, not investors accumulating.',
      });
    }
  }

  // 4) Volume surge without price corroboration (movers feeds, 30d)
  const w1s = (vg.data || []).map(r => r.week1_vol_change).filter(v => v != null);
  const pcts = (vg.data || []).map(r => Math.abs(r.pct_change)).filter(v => isFinite(v));
  const avgW1 = w1s.length ? mean(w1s) : null;
  if (avgW1 != null && avgW1 > 100) {
    const avgAbsPct = pcts.length ? mean(pcts) : 0;
    const corroboration = Math.min(1, avgAbsPct / (0.5 + avgW1 / 200));
    const gDays = (gl.data || []).filter(r => r.category === 'GAINER').length;
    const lDays = (gl.data || []).filter(r => r.category === 'LOSER').length;
    const churn = (gDays + lDays) ? Math.min(gDays, lDays) / (gDays + lDays) : 0;
    if (corroboration < 0.4) {
      flags.push({
        id: 'volume-trap', severity: 'amber',
        title: 'Volume surge without price movement',
        detail: `Volume ran +${Math.round(avgW1)}% vs its weekly average but price barely moved (${r1(avgAbsPct)}% avg move) — the print pattern of wash/HFT-inflated volume.`,
      });
    } else if (churn > 0.35) {
      flags.push({
        id: 'volume-churn', severity: 'amber',
        title: 'Heavy volume with gainer/loser flip-flopping',
        detail: `Appeared as top gainer ${gDays} day(s) and top loser ${lDays} day(s) in 30 days on surging volume — churny two-way speculation, not a trend.`,
      });
    }
  }

  // 5) Volatility spike — daily swings far outside the stock's own past year.
  // Not manipulation per se, but abnormal vol is the common backdrop of every
  // pattern above, and the single best "something changed, look closer" cue.
  const spike = hvSpike((hist.data || []).map(r => r.close).reverse());
  if (spike && spike.pctile >= 90) {
    const span = spike.points >= 200 ? 'past year' : `last ~${spike.points} sessions`;
    flags.push({
      id: 'vol-spike', severity: 'amber',
      title: `Volatility spike — swings bigger than ${Math.min(99, Math.round(spike.pctile))}% of its ${span}`,
      detail: `20-day realized volatility is ${r1(spike.hv20)}% annualized (≈±${r1(spike.hv20 / Math.sqrt(252))}%/day), near the top of its range over the ${span}. Something changed — check news, results and the shareholding tab before adding, and size smaller.`,
    });
  }

  return {
    symbol: sym, market: 'IN',
    source: 'NSE feeds + daily bhavcopy (surveillance, bulk deals, delivery %, movers)',
    asOf: rows[0]?.trade_date || null,
    checks: ['surveillance', 'deal churn', 'circuit ladder', 'distribution', 'low delivery', 'volume authenticity', 'volatility spike'],
    flags,
  };
}

module.exports = { indiaRedFlags };
