// ─── US manipulation red flags, from daily bars alone ────────────────────────
//
// The five checks the /api/us/red-flags/:symbol route runs on a stock's last
// 60 bars, as a function, so the picks engine can apply the same rule to every
// name in its universe without looping HTTP back into the server. The route
// keeps the sixth check (volatility spike) because that one reads a year of
// closes, not the 60-bar window.
//
// Severity is the contract: `red` is the only level the picks engine excludes
// on; `amber` is shown, never acted on.

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const r1 = (v) => (v == null || !isFinite(v) ? null : +v.toFixed(1));

function barFlags(barsIn) {
  const bars = (barsIn || []).slice(-60);
  const flags = [];
  if (bars.length < 25) return flags;
  const last20 = bars.slice(-20);

  // 1) Thin liquidity — easiest stock to manipulate is one nobody trades.
  const dollarVol = median(last20.map(b => b.close * b.volume));
  if (dollarVol != null && dollarVol < 1e6) {
    flags.push({
      id: 'thin-liquidity', severity: 'amber',
      title: `Thin liquidity (~$${(dollarVol / 1e6).toFixed(2)}M/day median)`,
      detail: 'Median dollar volume under $1M/day — wide spreads, easy to ramp, hard to exit. Micro-float names are the primary pump-and-dump vehicle in the US.',
    });
  }

  // 2) Pump-and-fade — vertical ramp followed by a break from the peak.
  const win = bars.slice(-30);
  let peakIdx = 0;
  win.forEach((b, i) => { if (b.close > win[peakIdx].close) peakIdx = i; });
  const preIdx = Math.max(0, peakIdx - 10);
  const ramp = win[preIdx].close > 0 ? win[peakIdx].close / win[preIdx].close - 1 : 0;
  const offPeak = win[peakIdx].close > 0 ? 1 - win[win.length - 1].close / win[peakIdx].close : 0;
  if (ramp >= 0.4 && offPeak >= 0.2) {
    flags.push({
      id: 'pump-fade', severity: 'red',
      title: 'Pump-and-fade pattern',
      detail: `Price ran +${r1(ramp * 100)}% into a peak within ~10 sessions, then dropped ${r1(offPeak * 100)}% from it — the footprint of a promoted ramp being distributed.`,
    });
  }

  // 3) Rising price on fading volume (distribution; volume is the best US
  //    proxy — there is no delivery % here).
  const run20 = last20[0].close > 0 ? last20[last20.length - 1].close / last20[0].close - 1 : 0;
  const volRecent = mean(last20.slice(-5).map(b => b.volume));
  const volPrior = mean(last20.slice(0, 15).map(b => b.volume));
  if (run20 >= 0.15 && volPrior > 0 && volRecent < volPrior * 0.65) {
    flags.push({
      id: 'fading-volume', severity: 'amber',
      title: 'Price rising on fading volume',
      detail: `Price +${r1(run20 * 100)}% over ~20 sessions while volume fell ${r1((1 - volRecent / volPrior) * 100)}% — fewer real buyers behind each new high.`,
    });
  }

  // 4) Gap-and-fade days — gapped open sold into all day.
  let gapFades = 0;
  for (let i = bars.length - 15; i < bars.length; i++) {
    const prev = bars[i - 1];
    if (prev && bars[i].open >= prev.close * 1.03 && bars[i].close <= bars[i].open * 0.985) gapFades++;
  }
  if (gapFades >= 3) {
    flags.push({
      id: 'gap-fade', severity: 'amber',
      title: `Repeated gap-and-fade sessions (${gapFades} of last 15)`,
      detail: 'Opens gapped up 3%+ then closed below the open — excitement at the open is being sold into, a common promoted-stock signature.',
    });
  }

  // 5) Volume spikes with no price move — churn/crossing prints.
  const medVol = median(last20.map(b => b.volume));
  let quietSpikes = 0;
  for (let i = bars.length - 10; i < bars.length; i++) {
    const prev = bars[i - 1];
    if (prev && medVol > 0 && bars[i].volume >= 5 * medVol && Math.abs(bars[i].close / prev.close - 1) < 0.015) quietSpikes++;
  }
  if (quietSpikes >= 2) {
    flags.push({
      id: 'quiet-volume-spike', severity: 'amber',
      title: `Volume spikes without price movement (${quietSpikes} day(s))`,
      detail: '5×+ normal volume with the price barely moving — block crossings or churn, not directional buying.',
    });
  }
  return flags;
}

module.exports = { barFlags };
