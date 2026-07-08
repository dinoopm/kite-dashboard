// ─── Portfolio X-Ray ─────────────────────────────────────────────────────────
// Runs every per-stock analytic the app already has across the user's actual
// Kite holdings and ranks them by a deterministic "attention score", so the
// Portfolio page can say "these 3 need a look" instead of just showing P&L.
//
// Score (documented so the UI tooltip can state it):
//   red flag: any red = +3, else any amber = +1
//   volatility: 20D HV at ≥90th percentile of available history = +2
//   institutional verdict tone 'warn' (distribution / promoter selling) = +2
//   technical signal in {AVOID, SELL (AT RANGE), TRIM, BEARISH} = +1
//   (BREAKOUT (CAUTION) is a bullish-entry caution, not a holding warning —
//   deliberately excluded.)
//
// Dependencies are injected by server.js so this module reuses the exact
// cached functions behind /api/red-flags, /api/institutional and /api/alerts
// rather than re-implementing or HTTP-looping back into itself.

const { createClient } = require('@supabase/supabase-js');
const { hvSpike } = require('../volMath');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const WARN_SIGNALS = new Set(['AVOID', 'SELL (AT RANGE)', 'TRIM', 'BEARISH']);

async function volBadge(sym) {
  const { data, error } = await supabase
    .from('nse_bhavcopy').select('close').eq('symbol', sym).eq('series', 'EQ')
    .order('trade_date', { ascending: false }).limit(400);
  if (error || !data?.length) return null;
  return hvSpike(data.map(r => r.close).reverse());
}

async function holdingXray(h, { redFlagsFor, institutionalFor, signalFor }) {
  const sym = h.tradingsymbol;
  const [flagsR, instR, volR, sigR] = await Promise.allSettled([
    redFlagsFor(sym),
    institutionalFor(sym),
    volBadge(sym),
    signalFor(h),
  ]);

  let score = 0;
  const badges = [];

  if (flagsR.status === 'fulfilled' && flagsR.value?.flags?.length) {
    const flags = flagsR.value.flags;
    const anyRed = flags.some(f => f.severity === 'red');
    score += anyRed ? 3 : 1;
    badges.push({
      id: 'red-flags', tone: anyRed ? 'alert' : 'warn',
      label: `${flags.length} red flag${flags.length > 1 ? 's' : ''}`,
      detail: flags.map(f => f.title).join(' · '),
    });
  }

  if (volR.status === 'fulfilled' && volR.value && volR.value.pctile >= 90) {
    score += 2;
    badges.push({
      id: 'vol-spike', tone: 'warn',
      label: 'vol spike',
      detail: `20D HV ${volR.value.hv20.toFixed(1)}% — ${Math.min(99, Math.round(volR.value.pctile))}th percentile of its range`,
    });
  }

  if (instR.status === 'fulfilled' && instR.value?.verdict?.tone === 'warn') {
    score += 2;
    badges.push({ id: 'institutional', tone: 'warn', label: instR.value.verdict.label.toLowerCase(), detail: instR.value.verdict.detail });
  } else if (instR.status === 'fulfilled' && instR.value?.verdict?.tone === 'good') {
    badges.push({ id: 'institutional', tone: 'good', label: 'accumulation', detail: instR.value.verdict.detail });
  }

  const action = sigR.status === 'fulfilled' ? sigR.value : null;
  if (action && WARN_SIGNALS.has(action)) {
    score += 1;
    badges.push({ id: 'signal', tone: 'warn', label: action.toLowerCase(), detail: `Technical signal: ${action}` });
  }

  return { symbol: sym, token: h.instrument_token, score, badges, signal: action };
}

// Holdings processed a few at a time: the first uncached pass hits screener.in
// once per symbol (institutional quarters), and sequential-ish traffic keeps
// that polite. Cached passes are all Supabase and return in one round.
async function portfolioXray(holdings, deps, { concurrency = 3 } = {}) {
  const out = [];
  for (let i = 0; i < holdings.length; i += concurrency) {
    const batch = holdings.slice(i, i + concurrency);
    out.push(...await Promise.all(batch.map(h => holdingXray(h, deps))));
  }
  out.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  const flagged = out.filter(r => r.score > 0);
  return {
    holdings: out,
    summary: {
      total: out.length,
      flagged: flagged.length,
      clean: out.length - flagged.length,
      worstThree: flagged.slice(0, 3).map(r => ({ symbol: r.symbol, score: r.score })),
    },
    scoring: 'red flag red=+3/amber=+1 · vol ≥90th pctile=+2 · institutional distribution=+2 · bearish signal=+1',
    asOf: new Date().toISOString(),
  };
}

module.exports = { portfolioXray };
