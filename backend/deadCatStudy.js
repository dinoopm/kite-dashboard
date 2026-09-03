// ─── Does a dead-cat bounce actually fade? ───────────────────────────────────
//
// The chart has called certain rallies dead-cat bounces since long before
// anything in this app was scored, and the phrase carries a prediction: buying
// that green day is a mistake. signals/registry.js now records the rule
// (`dead_cat_bounce`) so it gets a track record — but nse_bhavcopy starts
// 2026-04-02, and the badge on the chart is scored on Indian prices only, so
// the question a US chart raises cannot be answered there at all.
//
// US history answers it today. Same shape as baseBreakoutStudy.js and
// volumeThrustStudy.js, and the same four choices decide whether this is
// evidence or decoration:
//
// 1. NO RE-IMPLEMENTATION. The detector is imported from signals/registry.js.
//    A study that measures its own private copy of a rule says nothing about
//    the rule that ships.
// 2. THE CONTROL GROUP. "Bounces underperform" is meaningless without saying
//    against what. The control here is the SAME first-up-day after the SAME
//    sharp drop, on bars that have already reclaimed the 20-bar mean — the one
//    condition the rule adds. The two sets are disjoint, so a two-sample test
//    between them measures what the "below the mean" clause is worth, rather
//    than measuring a set against a superset containing it.
// 3. THE SWEEP. 10% over 10 bars under a 20-bar mean was picked by eye years
//    ago. Every point of a grid around it is reported, and the honest read is
//    whether an effect survives the grid or lives at one convenient corner.
// 4. DIRECTION. This is a BEARISH claim, so it is vindicated by a NEGATIVE
//    median excess. Verdicts say so in words rather than leaving a minus sign
//    to be read as a bad result.

const YahooFinance = require('yahoo-finance2').default;
const { buildSeries } = require('./backtest/indicators');
const { deadCatBounce, DROP_PCT, DROP_LOOKBACK, CROSS_MID } = require('./signals/registry');

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const BENCHMARK = '^GSPC';
const HISTORY_FROM = '2014-01-01';
const HORIZONS = [5, 10, 22];
const MIN_N = 30;
const FETCH_GAP_MS = 120;  // be polite to Yahoo

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const variance = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
};

/** One-sample t against zero: is the mean excess distinguishable from none? */
function tAgainstZero(xs) {
  if (xs.length < 2) return null;
  const sd = Math.sqrt(variance(xs));
  if (!sd) return null;
  return mean(xs) / (sd / Math.sqrt(xs.length));
}

/** Welch's t between two independent samples — unequal n and unequal variance. */
function twoSampleT(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const va = variance(a) / a.length;
  const vb = variance(b) / b.length;
  if (!(va + vb > 0)) return null;
  return (mean(a) - mean(b)) / Math.sqrt(va + vb);
}

async function fetchBars(symbol, from) {
  const c = await yf.chart(symbol, { period1: from, interval: '1d' }, { validateResult: false });
  return (c.quotes || [])
    .filter(q => q.close != null && q.high != null && q.low != null)
    .map(q => ({
      date: q.date.toISOString().slice(0, 10),
      high: q.high, low: q.low, close: q.close, volume: q.volume || 0,
    }));
}

const fwd = (closes, i, h) =>
  (i + h < closes.length && closes[i] > 0 ? ((closes[i + h] / closes[i]) - 1) * 100 : null);

/**
 * Every firing of the rule for one symbol, at one setting.
 *
 * `requireBelowMean: false` produces the SUPERSET — every first-up-day after
 * the same drop, wherever it sits relative to the mean — and the control group
 * is that superset minus the signal. Building it by subtraction rather than by
 * a second hand-written condition is what guarantees the two sets are disjoint
 * and exhaustive.
 */
function firingsFor(S, setting) {
  const signal = [];
  const all = [];
  for (let i = Math.max(1, setting.midPeriod + 1); i < S.dates.length; i++) {
    if (deadCatBounce(S, i, setting)) signal.push(i);
    if (deadCatBounce(S, i, { ...setting, requireBelowMean: false })) all.push(i);
  }
  const inSignal = new Set(signal);
  return { signal, control: all.filter(i => !inSignal.has(i)) };
}

function summarise(excess, raw, { bearish = true } = {}) {
  return HORIZONS.map(h => {
    const ex = excess[h];
    const t = tAgainstZero(ex) == null ? null : +tAgainstZero(ex).toFixed(2);
    const med = median(ex);
    // A bearish rule is vindicated by a NEGATIVE excess, so the verdict names
    // which way the number cuts instead of leaving a sign to be misread.
    const claim = med == null ? '' : med < 0 ? ' — the fade the rule claims' : ' — the opposite of the claim';
    return {
      horizon: `${h}d`,
      n: ex.length,
      medianExcessPct: med == null ? null : +med.toFixed(3),
      meanExcessPct: mean(ex) == null ? null : +mean(ex).toFixed(3),
      medianRawPct: median(raw[h]) == null ? null : +median(raw[h]).toFixed(3),
      hitRateExcessPct: ex.length ? +((ex.filter(v => v > 0).length / ex.length) * 100).toFixed(1) : null,
      tStat: t,
      underSampled: ex.length < MIN_N,
      verdict: !ex.length ? 'no firings'
        : ex.length < MIN_N ? `n=${ex.length} — too few to judge`
        : (t == null || Math.abs(t) < 2)
          ? `${med >= 0 ? '+' : ''}${med.toFixed(2)}% median excess, not distinguishable from noise (t=${t ?? '—'}, n=${ex.length})`
          : `${med >= 0 ? '+' : ''}${med.toFixed(2)}% median excess (t=${t}, n=${ex.length})${bearish ? claim : ''}`,
    };
  });
}

/**
 * Run the study across a symbol list.
 *
 * @param symbols  tickers to scan
 * @param grid     threshold combinations; the shipped setting is always included
 */
async function runDeadCatStudy({ symbols, from = HISTORY_FROM, grid = null, onProgress = null } = {}) {
  if (!symbols?.length) throw new Error('No symbols supplied');

  const benchBars = await fetchBars(BENCHMARK, from);
  const benchIdx = new Map(benchBars.map((b, i) => [b.date, i]));
  const benchCloses = benchBars.map(b => b.close);

  const shipped = { dropPct: DROP_PCT, lookback: DROP_LOOKBACK, midPeriod: CROSS_MID };
  const settings = grid || [
    { dropPct: 0.05, lookback: 10, midPeriod: 20 },
    shipped,                                        // the rule the chart draws
    { dropPct: 0.15, lookback: 10, midPeriod: 20 },
    { dropPct: 0.10, lookback: 5,  midPeriod: 20 },
    { dropPct: 0.10, lookback: 20, midPeriod: 20 },
    { dropPct: 0.10, lookback: 10, midPeriod: 50 },
  ];

  const seriesBySymbol = new Map();
  let fetched = 0, failed = 0;
  for (const sym of symbols) {
    try {
      const bars = await fetchBars(sym, from);
      if (bars.length > 60 + Math.max(...HORIZONS)) seriesBySymbol.set(sym, buildSeries(bars));
      fetched++;
    } catch { failed++; }
    if (onProgress && (fetched + failed) % 25 === 0) onProgress({ fetched, failed, total: symbols.length });
    await new Promise(r => setTimeout(r, FETCH_GAP_MS));
  }

  const results = [];
  for (const setting of settings) {
    const sets = {
      signal:  { excess: {}, raw: {}, firings: 0, symbols: new Set() },
      control: { excess: {}, raw: {}, firings: 0, symbols: new Set() },
    };
    for (const k of Object.keys(sets)) for (const h of HORIZONS) { sets[k].excess[h] = []; sets[k].raw[h] = []; }

    for (const [sym, S] of seriesBySymbol) {
      const found = firingsFor(S, setting);
      for (const [name, idxs] of [['signal', found.signal], ['control', found.control]]) {
        for (const i of idxs) {
          sets[name].firings++;
          sets[name].symbols.add(sym);
          const bi = benchIdx.get(S.dates[i]);
          for (const h of HORIZONS) {
            const r = fwd(S.closes, i, h);
            if (r == null) continue;
            sets[name].raw[h].push(r);
            const br = bi != null ? fwd(benchCloses, bi, h) : null;
            if (br != null) sets[name].excess[h].push(r - br);
          }
        }
      }
    }

    // What the "below the 20-bar mean" clause is worth: signal minus control,
    // two disjoint samples. A rule that says nothing beyond "price fell 10%"
    // shows up here as a lift indistinguishable from zero.
    const lift = HORIZONS.map(h => {
      const a = sets.signal.excess[h], b = sets.control.excess[h];
      const raw = twoSampleT(a, b);
      const t = raw == null ? null : +raw.toFixed(2);
      const d = (mean(a) != null && mean(b) != null) ? mean(a) - mean(b) : null;
      return {
        horizon: `${h}d`,
        meanDiffPct: d == null ? null : +d.toFixed(3),
        tStat: t,
        verdict: (a.length < MIN_N || b.length < MIN_N) ? 'too few in one of the two sets to compare'
          : (t == null || Math.abs(t) < 2)
            ? `below-the-mean adds ${d >= 0 ? '+' : ''}${d.toFixed(2)}%, not distinguishable from noise (t=${t ?? '—'})`
            : `below-the-mean adds ${d >= 0 ? '+' : ''}${d.toFixed(2)}% (t=${t}) — ${d < 0 ? 'the clause does select weaker bounces' : 'the clause selects STRONGER bounces, the opposite of its purpose'}`,
      };
    });

    results.push({
      setting,
      shipped: setting === shipped,
      sets: Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, {
        firings: v.firings,
        symbols: v.symbols.size,
        horizons: summarise(v.excess, v.raw),
      }])),
      lift,
    });
  }

  return {
    benchmark: BENCHMARK,
    period: { from: benchBars[0]?.date, to: benchBars[benchBars.length - 1]?.date },
    universe: { requested: symbols.length, usable: seriesBySymbol.size, failed },
    shipped,
    minN: MIN_N,
    results,
    caveats: [
      'A bearish rule is vindicated by a NEGATIVE median excess. Read the sign before the size.',
      'Survivorship bias: the universe is today\'s index members, so names that were delisted never appear. Here that cuts AGAINST the rule — the companies whose bounces really did fail hardest are the ones missing — so a fade measured on this universe is if anything understated.',
      'Firings cluster in time: bounces happen when the whole market has fallen, so many symbols fire in the same week for the same reason and n overstates the independent evidence badly.',
      'Entry at the bounce-day close. Costs, slippage and the cost of shorting are not modeled, and these are by construction falling, volatile names where all three are worst.',
      'The control group shares the drop and differs only in sitting above the 20-bar mean. It is not a random sample of bars, so the lift measures that clause, not the value of the whole rule.',
      'The grid is reported in full on purpose. An effect that appears at one threshold and vanishes at its neighbours is a property of the threshold, not of the market.',
    ],
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runDeadCatStudy, firingsFor, twoSampleT, tAgainstZero, HORIZONS, MIN_N };

if (require.main === module) {
  require('dotenv').config({ path: __dirname + '/../.env' });
  const limit = Number(process.argv[2]) || 0;
  const { getSP500 } = require('./usUniverses');
  (async () => {
    const universe = await getSP500();
    const symbols = (limit ? universe.slice(0, limit) : universe).map(r => r.symbol);
    process.stdout.write(`fetching ${symbols.length} symbols…\n`);
    const out = await runDeadCatStudy({
      symbols,
      onProgress: ({ fetched, failed, total }) => process.stdout.write(`  ${fetched + failed}/${total} (${failed} failed)\r`),
    });
    process.stdout.write('\n');
    console.log(`${out.universe.usable} symbols usable, ${out.period.from} → ${out.period.to}, benchmark ${out.benchmark}\n`);
    for (const r of out.results) {
      const s = r.setting;
      console.log(`${(s.dropPct * 100).toFixed(0)}% drop over ${s.lookback} bars, under the ${s.midPeriod}-bar mean${r.shipped ? '   ← the rule the chart draws' : ''}`);
      for (const nm of ['signal', 'control']) {
        const h = r.sets[nm].horizons.find(x => x.horizon === '10d');
        console.log(`  ${nm.padEnd(8)} ${String(r.sets[nm].firings).padStart(6)} firings   10d: ${h.verdict}`);
      }
      for (const l of r.lift) console.log(`  lift ${l.horizon.padEnd(4)} ${l.verdict}`);
      console.log('');
    }
    for (const c of out.caveats) console.log(`· ${c}`);
  })().catch(err => { console.error(err.message); process.exit(1); });
}
