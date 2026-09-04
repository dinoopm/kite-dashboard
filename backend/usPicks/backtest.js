// ─── US picks backtest — is the factor model any good? ───────────────────────
//
// Re-runs the engine's own factor maths at every 5th SPY session from 2015 and
// measures what the default-weight top picks did next. Same functions the live
// engine uses, imported not copied (volumeThrustStudy rule 3) — so this
// evaluates the rule that ships.
//
// What it can and cannot say, stated up front because the numbers will be
// quoted without the caveats:
//
//   · It scores the FOUR price factors. EPS revisions has no vintage history
//     and gets weight 0 here (BACKTEST_WEIGHTS). The live composite differs.
//   · Excess is reported two ways — over the universe median ("did the picks
//     beat the average stock") and over SPY ("did holding them beat the index").
//     They disagree; both are legitimate; neither is blended into the other.
//   · The momentum window is swept. 20/5 shipped for parity with India, not
//     because it is best here; the grid says which it is.
//   · The universe is TODAY'S members. Delisted losers are absent, which
//     flatters every long-horizon US backtest, this one included.
//
// Where this and usPicks/scorecard.js disagree, the scorecard is the honest
// number. It measures rows that were written before the outcome existed.

// dotenv loads before ./engine (which pulls in alpacaData.js, whose API_KEY
// and API_SECRET are read from process.env at import time) so the CLI run in
// Step 5 below actually sees the Alpaca credentials — same ordering rule
// server.js documents at its own dotenv.config() call.
require('dotenv').config({ path: __dirname + '/../../.env' });
const { loadInputs, buildUniverseFrom, rankUniverse, BACKTEST_WEIGHTS, indexAsOf } = require('./engine');

const HISTORY_FROM = '2015-01-01';
const HORIZONS = [5, 10, 22];
const MIN_SCORED = 50;   // fewer priced names than this on a date = too thin to score
const WARM_BARS = 260;   // 252 for the 52-week window, plus slack
const SWEEP = [{ window: 20, skip: 5 }, { window: 60, skip: 5 }, { window: 120, skip: 20 }, { window: 252, skip: 21 }];

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
function midRanks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const r = (i + j) / 2 + 1; for (let k = i; k <= j; k++) ranks[idx[k][1]] = r; i = j + 1; }
  return ranks;
}
function spearman(xs, ys) {
  const n = xs.length; if (n < 3) return null;
  const rx = midRanks(xs), ry = midRanks(ys), mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}
const tOfMean = (a) => { const m = mean(a); if (a.length < 2 || m == null) return null; const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); return sd ? +(m / (sd / Math.sqrt(a.length))).toFixed(2) : null; };

/** Indices into spyBars to evaluate at: every `step` bars once warm, leaving room for the longest horizon. */
function evalIndices(spyBars, { from, step, minWarm, maxHorizon }) {
  const out = [];
  for (let i = minWarm; i + maxHorizon < spyBars.length; i += step) if (spyBars[i].date >= from) out.push(i);
  return out;
}

/** Forward return of `symbol` from the bar on `date` to `h` SPY sessions later. */
function forwardFrom(bars, dateIdxOnSpy, spyBars, h) {
  const d0 = spyBars[dateIdxOnSpy]?.date, d1 = spyBars[dateIdxOnSpy + h]?.date;
  if (!d0 || !d1) return null;
  const i0 = indexAsOf(bars, d0), i1 = indexAsOf(bars, d1);
  if (i0 < 0 || i1 < 0 || bars[i0].date !== d0 || bars[i1].date !== d1) return null;
  const c0 = bars[i0].close, c1 = bars[i1].close;
  return c0 > 0 ? c1 / c0 - 1 : null;
}

/** One evaluation date: rank on bars ≤ asOf, then look forward. Pure. */
function evaluateAt(inputs, { asOf, momentum = {}, horizons = HORIZONS, topN = 25, weights = BACKTEST_WEIGHTS }) {
  const universe = buildUniverseFrom(inputs, { asOf, momentum });
  const ranked = rankUniverse(universe.stocks, weights);
  const spyIdx = indexAsOf(inputs.spyBars, asOf);
  const out = { evalDate: universe.period.snapshotDate, universe: ranked.length, horizons: {}, icComposite: null, icByFactor: null, top: ranked.slice(0, topN).map(r => ({ symbol: r.symbol, composite: r.composite })) };

  for (const h of horizons) {
    const spyRet = forwardFrom(inputs.spyBars, spyIdx, inputs.spyBars, h);
    const rows = [];
    for (const s of ranked) {
      const ret = forwardFrom(inputs.barsBySymbol[s.symbol], spyIdx, inputs.spyBars, h);
      if (ret == null) continue;
      rows.push({ rank: s.rank, composite: s.composite, pct: s.pct, ret });
    }
    if (rows.length < MIN_SCORED) continue;
    const uniMedian = median(rows.map(r => r.ret));
    const top = rows.filter(r => r.rank <= topN);
    const top10 = rows.filter(r => r.rank <= 10);
    if (!top.length) continue;
    const sorted = [...rows].sort((a, b) => a.rank - b.rank);
    const q = Math.floor(sorted.length / 5) || 1;
    const quintiles = [[], [], [], [], []];
    // When sorted.length isn't divisible by 5, the remainder rows spill into
    // the last bucket via Math.min(4, ...) — the worst-ranked quintile grows,
    // Q1 (best-ranked) never does.
    sorted.forEach((r, k) => quintiles[Math.min(4, Math.floor(k / q))].push(r.ret));
    out.horizons[h] = {
      scored: rows.length, picks: top.length,
      topMean: mean(top.map(r => r.ret)), top10Mean: top10.length ? mean(top10.map(r => r.ret)) : null,
      uniMedian, spyRet,
      excessVsMedian: mean(top.map(r => r.ret)) - uniMedian,
      excessVsSpy: spyRet == null ? null : mean(top.map(r => r.ret)) - spyRet,
      top10ExcessVsSpy: spyRet == null || !top10.length ? null : mean(top10.map(r => r.ret)) - spyRet,
      hits: top.filter(r => r.ret > uniMedian).length,
      quintiles: quintiles.map(x => (x.length ? mean(x) : null)),
    };
    if (h === 10) {
      out.icComposite = spearman(rows.map(r => r.composite), rows.map(r => r.ret));
      out.icByFactor = Object.fromEntries(['momentum', 'volume', 'fiftyTwo', 'relStrength'].map(f => [f, spearman(rows.map(r => r.pct[f]), rows.map(r => r.ret))]));
    }
  }
  return out;
}

async function runUsBacktest({ from = HISTORY_FROM, step = 5, topN = 25, horizons = HORIZONS, inputs = null } = {}) {
  const inp = inputs || await loadInputs({ from, includeRevisions: false, includeEarnings: false });
  // Reserve room for the LONGEST horizon, not the shortest. Reserving less
  // doesn't corrupt any single number — forwardFrom's exact-date guard just
  // returns null and the row drops — but it silently shortens the sample for
  // the longer horizons, so the 5/10/22-day rows in the summary table would
  // be measured over three different date sets instead of one shared sample.
  const idxs = evalIndices(inp.spyBars, { from, step, minWarm: WARM_BARS, maxHorizon: Math.max(...horizons) });
  if (!idxs.length) throw new Error('Not enough history to evaluate');

  const perDate = [];
  for (const i of idxs) perDate.push(evaluateAt(inp, { asOf: inp.spyBars[i].date, horizons, topN }));

  const pct = (v) => (v == null ? null : +(v * 100).toFixed(2));
  const summary = horizons.map(h => {
    const ds = perDate.filter(d => d.horizons[h]);
    const exM = ds.map(d => d.horizons[h].excessVsMedian);
    const exS = ds.map(d => d.horizons[h].excessVsSpy).filter(v => v != null);
    const ex10 = ds.map(d => d.horizons[h].top10ExcessVsSpy).filter(v => v != null);
    const hits = ds.reduce((s, d) => s + d.horizons[h].hits, 0), total = ds.reduce((s, d) => s + d.horizons[h].picks, 0);
    const quint = [0, 1, 2, 3, 4].map(k => { const xs = ds.map(d => d.horizons[h].quintiles[k]).filter(v => v != null); return pct(mean(xs)); });
    return {
      horizon: h, evalDates: ds.length,
      meanExcessVsMedianPct: pct(mean(exM)), tVsMedian: tOfMean(exM),
      meanExcessVsSpyPct: pct(mean(exS)), tVsSpy: tOfMean(exS),
      top10ExcessVsSpyPct: pct(mean(ex10)),
      hitRatePct: total ? +((hits / total) * 100).toFixed(1) : null, pickObs: total,
      quintileMeansPct: quint,
    };
  });

  const icOf = (pick) => { const a = perDate.map(pick).filter(v => v != null); return { meanIC: a.length ? +mean(a).toFixed(3) : null, tStat: tOfMean(a), dates: a.length }; };
  const ics = [
    ...['momentum', 'volume', 'fiftyTwo', 'relStrength'].map(f => ({ factor: f, ...icOf(d => d.icByFactor?.[f]) })),
    { factor: 'composite', ...icOf(d => d.icComposite) },
  ];

  // The momentum sweep, 10-day horizon, excess over SPY and composite IC.
  const sweep = SWEEP.map(m => {
    const ds = idxs.map(i => evaluateAt(inp, { asOf: inp.spyBars[i].date, momentum: m, horizons: [10], topN }));
    const ex = ds.map(d => d.horizons[10]?.excessVsSpy).filter(v => v != null);
    const ic = ds.map(d => d.icComposite).filter(v => v != null);
    return { momentum: m, horizon: '10d', evalDates: ex.length, meanExcessVsSpyPct: pct(mean(ex)), tStat: tOfMean(ex), icComposite: ic.length ? +mean(ic).toFixed(3) : null, shipped: m.window === 20 && m.skip === 5 };
  });

  return {
    params: { from, step, topN, horizons, weights: BACKTEST_WEIGHTS, benchmark: 'SPY' },
    period: { firstEval: perDate[0].evalDate, lastEval: perDate[perDate.length - 1].evalDate, evalDates: perDate.length, universe: inp.members.length },
    summary, ics, sweep,
    caveats: [
      'Scores the FOUR price factors with EPS revisions at weight 0; the live composite includes revisions at 15. This is the same model with one input unavailable, not a different one.',
      'Survivorship bias: the universe is today\'s index members, so companies that were delisted or dropped never appear. That flatters every long-horizon US backtest, this one included.',
      'Evaluation dates are a week apart and picks overlap between them, so n overstates the independent evidence.',
      'Entry at the evaluation-date close; costs, slippage and liquidity are not modeled.',
      'Earnings and red-flag exclusions cannot be reconstructed for past dates, so the backtest universe is slightly wider than the live one.',
      'Where this and the scorecard disagree, the scorecard is the honest number.',
    ],
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runUsBacktest, evaluateAt, evalIndices, SWEEP, HISTORY_FROM };

if (require.main === module) {
  runUsBacktest().then(out => {
    console.log(`${out.period.evalDates} evaluation dates, ${out.period.firstEval} → ${out.period.lastEval}, universe ${out.period.universe}\n`);
    for (const s of out.summary) console.log(`${String(s.horizon).padStart(2)}d  top25 vs median ${s.meanExcessVsMedianPct}% (t=${s.tVsMedian})   vs SPY ${s.meanExcessVsSpyPct}% (t=${s.tVsSpy})   top10 vs SPY ${s.top10ExcessVsSpyPct}%   hit ${s.hitRatePct}%   Q1…Q5 ${s.quintileMeansPct.join(' / ')}`);
    console.log('\nIC (10d):'); for (const i of out.ics) console.log(`  ${i.factor.padEnd(12)} ${i.meanIC}  t=${i.tStat}  n=${i.dates}`);
    console.log('\nMomentum sweep (10d, vs SPY):'); for (const s of out.sweep) console.log(`  ${s.momentum.window}/${s.momentum.skip}${s.shipped ? ' ←shipped' : ''}  ${s.meanExcessVsSpyPct}% (t=${s.tStat})  IC ${s.icComposite}`);
    console.log(''); for (const c of out.caveats) console.log(`· ${c}`);
  }).catch(e => { console.error(e.message); process.exit(1); });
}
