// ─── Does volume confirmation improve the golden-cross buy? ──────────────────
//
// The Signals tab now draws volume alongside its Buy markers, and the obvious
// next step is to USE it: only take the cross when heavy volume is behind it.
// That is a filter, and this repo's rule is that a filter has to earn its place
// before it changes what anybody is shown.
//
// India cannot answer this yet. nse_bhavcopy starts 2026-04-02, a golden cross
// needs 50 bars before it can fire at all, and the confirmed and unconfirmed
// halves then split what little is left — signals/scorecard.js will say "too
// few to judge" for months. So the question gets answered on US history now,
// the same move baseBreakoutStudy.js made for the year-long base, and the same
// three design choices decide whether this is evidence or decoration:
//
// 1. THE CONTROL GROUP. The comparison is confirmed vs UNCONFIRMED, never
//    confirmed vs all-crosses: the "all" set contains the confirmed firings, so
//    that comparison is partly a set against itself and understates any real
//    difference in both directions. Two disjoint sets, and a two-sample test
//    between them.
// 2. THE SWEEP. The shipped setting (2× volume, a 5-session window) was picked
//    by eye. One number at one setting proves nothing; the honest read is
//    whether an effect survives the grid or lives at a single convenient
//    corner. Every grid point is reported.
// 3. NO RE-IMPLEMENTATION. The detectors are imported from signals/registry.js
//    rather than rewritten here. A study that measures its own private copy of
//    a rule tells you nothing about the rule that ships.

const YahooFinance = require('yahoo-finance2').default;
const { buildSeries } = require('./backtest/indicators');
const {
  maCrossUp, thrustWithin, volumeThrust,
  VOLUME_THRUST_MULT, CONFIRM_WINDOW, CROSS_SLOW,
} = require('./signals/registry');

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const BENCHMARK = '^GSPC';
const HISTORY_FROM = '2014-01-01';
const HORIZONS = [5, 10, 22];
const MIN_N = 30;

// The cross rule's own gate is RSI > 50, so these are TIGHTER cuts of it. The
// screener ships a preset at 60, which was picked by eye — and 60 turns out to
// sit almost exactly at the median RSI-at-cross (59.1 over a synthetic sweep),
// i.e. the densest part of the distribution and so the most unstable place a
// threshold can sit. Whether that matters is what this sweep is for.
const RSI_GATES = [55, 60, 65, 70];
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

/** One-sample t against zero: is this set's mean excess distinguishable from none? */
function tAgainstZero(xs) {
  if (xs.length < 2) return null;
  const sd = Math.sqrt(variance(xs));
  if (!sd) return null;
  return mean(xs) / (sd / Math.sqrt(xs.length));
}

/**
 * Welch's two-sample t: is set A's mean above set B's by more than the spread
 * of the two samples explains?
 *
 * Welch rather than Student because the two groups have neither equal variance
 * nor equal size — confirmed firings are the rarer half, and heavy-volume days
 * are more volatile by construction, so assuming a pooled variance would
 * overstate significance in exactly the direction that flatters the filter.
 */
function welchT(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const va = variance(a), vb = variance(b);
  const se = Math.sqrt(va / a.length + vb / b.length);
  if (!se) return null;
  return (mean(a) - mean(b)) / se;
}

const fwd = (closes, i, h) =>
  (i + h < closes.length && closes[i] > 0 ? ((closes[i + h] / closes[i]) - 1) * 100 : null);

/**
 * Yahoo uses a dash where Alpaca (and usUniverses) use a dot: BRK.B is BRK-B.
 * Left unconverted these fail the fetch and silently shrink the universe.
 */
const toYahoo = (sym) => String(sym).replace('.', '-');

async function fetchBars(symbol, from) {
  const c = await yf.chart(toYahoo(symbol), { period1: from, interval: '1d' }, { validateResult: false });
  return (c.quotes || [])
    .filter(q => q.close != null && q.high != null && q.low != null)
    .map(q => ({
      date: q.date.toISOString().slice(0, 10),
      high: q.high, low: q.low, close: q.close,
      // Volume is the whole point here, so a bar without it is not usable —
      // but Yahoo does return null volume on some early/holiday bars, and
      // dropping the bar entirely would put a hole in the trading calendar and
      // shift every horizon after it. Zero keeps the bar and simply cannot
      // clear a thrust threshold.
      volume: q.volume == null ? 0 : q.volume,
    }));
}

/**
 * Every golden-cross buy in one symbol's series, split by whether volume
 * confirmed it at this grid setting, plus the standalone thrusts.
 *
 * Pure and network-free, so the arithmetic is unit-testable without Yahoo.
 */
function findEvents(bars, { mult = VOLUME_THRUST_MULT, window = CONFIRM_WINDOW } = {}) {
  const S = buildSeries(bars);
  const crosses = [];
  const thrusts = [];
  for (let i = CROSS_SLOW + 1; i < bars.length; i++) {
    const hit = maCrossUp(S, i);
    if (hit) {
      const at = thrustWithin(S, i, window, mult);
      // rsi rides along so the RSI gate can be swept without re-detecting —
      // and it is the detector's own figure, not a second reading of the
      // indicator, so the sweep measures the rule that ships.
      crosses.push({ index: i, date: bars[i].date, rsi: hit.rsi, confirmed: at >= 0, barsAgo: at >= 0 ? i - at : null });
    }
    if (volumeThrust(S, i, mult)) thrusts.push({ index: i, date: bars[i].date });
  }
  return { crosses, thrusts };
}

/** Present one event set's forward excess returns. */
function describeSet(excess, raw, { firings, symbols }) {
  return {
    firings,
    symbols,
    horizons: HORIZONS.map(h => {
      const ex = excess[h];
      const t = tAgainstZero(ex);
      // Rounded once, here, because the verdict STRING interpolates it too —
      // printing the raw float put "t=-0.5658651160809486" in the output.
      const tr = t == null ? null : +t.toFixed(2);
      const med = median(ex);
      return {
        horizon: `${h}d`,
        n: ex.length,
        medianExcessPct: med == null ? null : +med.toFixed(3),
        meanExcessPct: mean(ex) == null ? null : +mean(ex).toFixed(3),
        medianRawPct: median(raw[h]) == null ? null : +median(raw[h]).toFixed(3),
        hitRateExcessPct: ex.length ? +((ex.filter(v => v > 0).length / ex.length) * 100).toFixed(1) : null,
        tStat: tr,
        underSampled: ex.length < MIN_N,
        verdict: !ex.length ? 'no firings'
          : ex.length < MIN_N ? `n=${ex.length} — too few to judge`
          : (t == null || Math.abs(t) < 2)
            ? `${med >= 0 ? '+' : ''}${med.toFixed(2)}% median excess, not distinguishable from noise (t=${tr ?? '—'}, n=${ex.length})`
            : `${med >= 0 ? '+' : ''}${med.toFixed(2)}% median excess (t=${tr}, n=${ex.length})`,
      };
    }),
  };
}

/** Roll a list of per-event {excess, raw} into the same shape describeSet takes. */
function describeEvents(events) {
  const excess = {}, raw = {};
  for (const h of HORIZONS) {
    excess[h] = events.map(e => e.excess[h]).filter(v => v != null);
    raw[h] = events.map(e => e.raw[h]).filter(v => v != null);
  }
  return describeSet(excess, raw, {
    firings: events.length,
    symbols: new Set(events.map(e => e.symbol)).size,
  });
}

/**
 * Sweep the RSI gate on the cross.
 *
 * The comparison here CANNOT be the one used for volume. Confirmed and quiet
 * are disjoint halves, so they are two independent samples. RSI gates are
 * NESTED — every cross above 65 is also above 60 — so comparing gate to gate
 * compares a set with a subset of itself, and the overlap guarantees a
 * flattering answer in whichever direction the subset happens to lean.
 *
 * The honest split at each gate is KEPT (rsi > gate) against DROPPED
 * (rsi <= gate) within the same parent set: precisely the firings the gate
 * throws away. If the dropped half does as well, the gate is discarding
 * firings for nothing, which is the same verdict the volume lift reports.
 *
 * Swept over two populations because the shipped preset stacks both filters:
 * every cross, and the volume-confirmed ones alone. A gate can look useful on
 * all crosses and add nothing once volume has already selected the same
 * firings — the two filters are not independent, and only the second column
 * answers what the preset actually does.
 */
function rsiSweep(events, gates = RSI_GATES) {
  const run = (pool) => gates.map(gate => {
    const kept = pool.filter(e => e.rsi > gate);
    const dropped = pool.filter(e => e.rsi <= gate);
    return {
      gate,
      kept: describeEvents(kept),
      dropped: describeEvents(dropped),
      lift: HORIZONS.map(h => {
        const a = kept.map(e => e.excess[h]).filter(v => v != null);
        const b = dropped.map(e => e.excess[h]).filter(v => v != null);
        const t = welchT(a, b);
        const tr = t == null ? null : +t.toFixed(2);
        const diff = (mean(a) == null || mean(b) == null) ? null : mean(a) - mean(b);
        return {
          horizon: `${h}d`,
          nKept: a.length,
          nDropped: b.length,
          meanDiffPct: diff == null ? null : +diff.toFixed(3),
          tStat: tr,
          verdict: (a.length < MIN_N || b.length < MIN_N)
            ? `too few to judge (kept n=${a.length}, dropped n=${b.length})`
            : (t == null || Math.abs(t) < 2)
              ? `no measurable difference (${diff >= 0 ? '+' : ''}${diff.toFixed(2)}pp, t=${tr ?? '—'}) — the gate would discard firings for nothing`
              : `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}pp for kept firings (t=${tr})`,
        };
      }),
    };
  });

  const confirmed = events.filter(e => e.confirmed);
  return {
    baseline: {
      allCrosses: describeEvents(events),
      confirmedOnly: describeEvents(confirmed),
    },
    allCrosses: run(events),
    confirmedOnly: run(confirmed),
  };
}

/**
 * Run the study across a symbol list.
 *
 * @param symbols  tickers to scan (usUniverses.getSP500 gives the usual set)
 * @param grid     {mult, window} combinations to sweep
 */
async function runVolumeThrustStudy({ symbols, from = HISTORY_FROM, grid = null, onProgress = null } = {}) {
  if (!symbols?.length) throw new Error('No symbols supplied');

  const benchBars = await fetchBars(BENCHMARK, from);
  const benchIdx = new Map(benchBars.map((b, i) => [b.date, i]));
  const benchCloses = benchBars.map(b => b.close);

  const settings = grid || [
    { mult: 1.5, window: CONFIRM_WINDOW },
    { mult: 2, window: 0 },                 // thrust must land ON the cross bar
    { mult: 2, window: 3 },
    { mult: 2, window: CONFIRM_WINDOW },    // the shipped setting
    { mult: 2, window: 10 },
    { mult: 2.5, window: CONFIRM_WINDOW },
    { mult: 3, window: CONFIRM_WINDOW },
  ];

  // symbol -> bars, fetched once and reused across every grid point.
  const barsBySymbol = new Map();
  let fetched = 0, failed = 0;
  for (const sym of symbols) {
    try {
      const b = await fetchBars(sym, from);
      if (b.length > CROSS_SLOW + Math.max(...HORIZONS)) barsBySymbol.set(sym, b);
      fetched++;
    } catch { failed++; }
    if (onProgress && (fetched + failed) % 25 === 0) onProgress({ fetched, failed, total: symbols.length });
    await new Promise(r => setTimeout(r, FETCH_GAP_MS));
  }

  const results = [];
  for (const setting of settings) {
    // Four sets: every buy, the confirmed half, the unconfirmed half, and the
    // thrust on its own (which is a different claim — no cross required).
    const names = ['cross', 'confirmed', 'quiet', 'thrust'];
    const acc = {};
    for (const nm of names) {
      acc[nm] = { excess: {}, raw: {}, firings: 0, symbols: new Set() };
      for (const h of HORIZONS) { acc[nm].excess[h] = []; acc[nm].raw[h] = []; }
    }

    for (const [sym, bars] of barsBySymbol) {
      const closes = bars.map(b => b.close);
      const { crosses, thrusts } = findEvents(bars, setting);
      const push = (nm, ev) => {
        const a = acc[nm];
        a.firings++;
        a.symbols.add(sym);
        const bi = benchIdx.get(ev.date);
        for (const h of HORIZONS) {
          const r = fwd(closes, ev.index, h);
          if (r == null) continue;
          a.raw[h].push(r);
          // Excess only when the benchmark resolves over the SAME window;
          // otherwise the comparison is against nothing.
          const br = bi != null ? fwd(benchCloses, bi, h) : null;
          if (br != null) a.excess[h].push(r - br);
        }
      };
      for (const c of crosses) { push('cross', c); push(c.confirmed ? 'confirmed' : 'quiet', c); }
      for (const t of thrusts) push('thrust', t);
    }

    const sets = {};
    for (const nm of names) {
      sets[nm] = describeSet(acc[nm].excess, acc[nm].raw, { firings: acc[nm].firings, symbols: acc[nm].symbols.size });
    }

    // The actual question: does the confirmed half beat the unconfirmed one?
    // Reported per horizon as a difference of means with Welch's t, because
    // "confirmed looks better" is not a finding until the two samples are
    // compared against their own spread.
    const lift = HORIZONS.map(h => {
      const a = acc.confirmed.excess[h], b = acc.quiet.excess[h];
      const t = welchT(a, b);
      const tr = t == null ? null : +t.toFixed(2);
      const diff = (mean(a) == null || mean(b) == null) ? null : mean(a) - mean(b);
      return {
        horizon: `${h}d`,
        nConfirmed: a.length,
        nQuiet: b.length,
        meanDiffPct: diff == null ? null : +diff.toFixed(3),
        tStat: tr,
        verdict: (a.length < MIN_N || b.length < MIN_N)
          ? `too few to judge (confirmed n=${a.length}, quiet n=${b.length})`
          : (t == null || Math.abs(t) < 2)
            ? `no measurable difference (${diff >= 0 ? '+' : ''}${diff.toFixed(2)}pp, t=${tr ?? '—'}) — the filter would discard firings for nothing`
            : `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}pp for confirmed firings (t=${tr})`,
      };
    });

    results.push({ setting, sets, lift });
  }

  // The RSI sweep runs at the SHIPPED volume setting only. Crossing it with the
  // whole volume grid would print 28 panels and invite picking the best corner
  // of a 2-D grid, which is how a threshold gets chosen by its own result.
  const shippedSetting = { mult: VOLUME_THRUST_MULT, window: CONFIRM_WINDOW };
  const crossEvents = [];
  for (const [sym, bars] of barsBySymbol) {
    const closes = bars.map(b => b.close);
    const { crosses } = findEvents(bars, shippedSetting);
    for (const c of crosses) {
      const bi = benchIdx.get(c.date);
      const excess = {}, raw = {};
      for (const h of HORIZONS) {
        const r = fwd(closes, c.index, h);
        raw[h] = r;
        const br = bi != null ? fwd(benchCloses, bi, h) : null;
        excess[h] = (r != null && br != null) ? r - br : null;
      }
      crossEvents.push({ symbol: sym, rsi: c.rsi, confirmed: c.confirmed, excess, raw });
    }
  }

  return {
    rsi: { gates: RSI_GATES, at: shippedSetting, ...rsiSweep(crossEvents) },
    benchmark: BENCHMARK,
    period: { from: benchBars[0]?.date, to: benchBars[benchBars.length - 1]?.date },
    universe: { requested: symbols.length, usable: barsBySymbol.size, failed },
    shipped: { mult: VOLUME_THRUST_MULT, window: CONFIRM_WINDOW },
    minN: MIN_N,
    results,
    caveats: [
      'Survivorship bias: the universe is today\'s index members, so companies delisted or dropped along the way never appear. Every long-horizon US backtest is flattered by this, including this one.',
      'Firings cluster in time — heavy volume is largely a market-wide event, so many symbols confirm in the same week — and that hits the confirmed half harder than the quiet half. n overstates the independent evidence on both sides, and more so on the confirmed side.',
      'Volume here is consolidated Yahoo volume, not the partial-venue feed. A study run on IEX-only volume would measure roughly 2-3% of the tape and mean nothing.',
      'Entry at the firing day close; costs, slippage and liquidity are not modeled. Volume-confirmed entries are, by construction, entries on days when spreads and impact are worst.',
      'Excess is over the index. Over a decade-long bull market raw return flatters everything, which is why the verdicts use excess.',
      'The grid is reported in full on purpose. An effect that appears at one setting and vanishes at its neighbours is a property of the setting, not of the market.',
      'RSI gates are nested, so each one is compared against the firings it discards rather than against another gate. Read the confirmedOnly column for the shipped preset: a gate that helps on all crosses may add nothing once volume confirmation has already selected the same firings.',
      'MULTIPLE COMPARISONS. The RSI sweep adds 4 gates x 2 populations x 3 horizons = 24 more two-sample tests on top of the volume grid. At the |t|>2 bar roughly one in twenty lands there by chance, so one or two "findings" per run are expected even when nothing is there — a harness run on random walks, where by construction no effect exists, produced a t=-2.2. Do not read a single starred cell as a result. What counts is a run of neighbouring gates pointing the same way, which is the shape a real effect has and a coincidence does not.',
      'Raising the RSI gate shrinks n monotonically, so the tightest gates lose significance partly because they are smaller, not only because they are worse. Compare medians across gates, not just the t-stats.',
      'A US result does not transfer automatically to NSE. It is evidence about the RULE, not about Indian stocks; signals/scorecard.js is what will eventually answer that, once ma_cross_volume has resolved firings there.',
    ],
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  runVolumeThrustStudy, findEvents, rsiSweep, describeEvents,
  welchT, tAgainstZero, HORIZONS, MIN_N, BENCHMARK, RSI_GATES,
};

// Run: node volumeThrustStudy.js [limit]
// Fetches years of daily bars for the whole universe, so it takes a few minutes
// and is deliberately not wired to an HTTP route.
if (require.main === module) {
  require('dotenv').config({ path: __dirname + '/../.env' });
  const limit = Number(process.argv[2]) || 0;
  const { getSP500 } = require('./usUniverses');
  (async () => {
    const universe = await getSP500();
    const symbols = (limit ? universe.slice(0, limit) : universe).map(r => r.symbol);
    process.stdout.write(`fetching ${symbols.length} symbols…\n`);
    const out = await runVolumeThrustStudy({
      symbols,
      onProgress: ({ fetched, failed, total }) => process.stdout.write(`  ${fetched + failed}/${total} (${failed} failed)\r`),
    });
    process.stdout.write('\n');
    console.log(`${out.universe.usable} symbols usable, ${out.period.from} → ${out.period.to}, benchmark ${out.benchmark}\n`);
    for (const r of out.results) {
      const shipped = r.setting.mult === out.shipped.mult && r.setting.window === out.shipped.window;
      console.log(`${r.setting.mult}× volume, ${r.setting.window}-session window${shipped ? '   ← the shipped setting' : ''}`);
      for (const nm of ['cross', 'confirmed', 'quiet', 'thrust']) {
        const h = r.sets[nm].horizons.find(x => x.horizon === '10d');
        console.log(`  ${nm.padEnd(10)} ${String(r.sets[nm].firings).padStart(6)} firings   10d: ${h.verdict}`);
      }
      for (const l of r.lift) console.log(`  lift ${l.horizon.padEnd(5)} ${l.verdict}`);
      console.log('');
    }

    // ── RSI gate sweep ──
    const rsiAt = out.rsi.at;
    console.log(`RSI gate on the cross (at ${rsiAt.mult}× volume, ${rsiAt.window}-session window)`);
    console.log('The cross rule already gates RSI > 50; these are tighter cuts of it.');
    console.log('24 tests below — expect one or two to clear |t|>2 by chance. Look for a run of');
    console.log('neighbouring gates agreeing, not a single starred cell.\n');
    for (const [pool, label] of [['allCrosses', 'all crosses'], ['confirmedOnly', 'volume-confirmed crosses only']]) {
      const base = out.rsi.baseline[pool === 'allCrosses' ? 'allCrosses' : 'confirmedOnly'];
      const b10 = base.horizons.find(x => x.horizon === '10d');
      console.log(`  ${label} — baseline (RSI>50): ${base.firings} firings, 10d: ${b10.verdict}`);
      for (const g of out.rsi[pool]) {
        const k = g.kept.horizons.find(x => x.horizon === '10d');
        const d = g.dropped.horizons.find(x => x.horizon === '10d');
        console.log(`    RSI > ${g.gate}   kept ${String(g.kept.firings).padStart(5)} / dropped ${String(g.dropped.firings).padStart(5)}`);
        console.log(`             kept 10d:    ${k.verdict}`);
        console.log(`             dropped 10d: ${d.verdict}`);
        for (const l of g.lift) console.log(`             gate ${l.horizon.padEnd(4)} ${l.verdict}`);
      }
      console.log('');
    }

    for (const c of out.caveats) console.log(`· ${c}`);
  })().catch(err => { console.error(err.message); process.exit(1); });
}
