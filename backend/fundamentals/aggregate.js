// ─── Sector & index earnings aggregation ─────────────────────────────────────
//
// Pure forward-looking-free arithmetic over stored fundamentals: given a scope's
// constituents and a quarter, what did the earnings actually do, and why. No
// fetching, no database — the same division of labour as signalScoring.js, and
// for the same reason: the part that decides what a number MEANS should be
// testable without a network.
//
// The whole module exists to refuse to print numbers that don't mean anything.
// "Sector EPS +20%" is uninterpretable until you know whether it came from
// revenue, margin, a tax rate, a buyback or one company — so every headline here
// is decomposable and every aggregate carries the coverage it was computed on.
//
// Nothing here claims anything about future prices. It reports what was
// reported. A claim that earnings growth PREDICTS returns would be a signal and
// would need a registry entry, recording and a scorecard badge like everything
// else in this codebase.

// Coverage floors. Both must clear: a sector where 7 of 10 names have reported
// can still be 19% of the profit pool, and the count alone would wave it
// through. See the "missing giant" fixture.
const MIN_COUNT_COVERAGE_PCT = 60;
const MIN_POOL_COVERAGE_PCT = 60;

// A company's growth % is dropped when its base is negligible NEXT TO ITS PEERS.
// Relative rather than absolute because the unit differs by market (₹ Cr vs USD)
// and by scope (a small-cap sector's normal base is another's rounding error).
const BASE_FLOOR_FRACTION = 0.01;

// The pool's own base is suppressed when profits and losses nearly cancel: a net
// of ₹10 Cr against a gross of ₹1,990 Cr divides into an artefact, not a growth
// rate.
const POOL_NET_TO_GROSS_FLOOR = 0.10;

// Periods pair by DATE. Counting back N rows silently turns a missing quarter
// into a shorter comparison, which is the single easiest way to be wrong here.
const YOY_DAYS = 365, YOY_TOL_DAYS = 45;
const QOQ_DAYS = 91, QOQ_TOL_DAYS = 25;
const TTM_QUARTERS = 8, TTM_MAX_GAP_DAYS = 120;

// Screener renders EPS to 2 decimals, so implied shares (netProfit/eps) inherit
// ±0.005/eps, doubled across two periods. A flat 2% buyback flag is pure noise
// below ~₹0.50 EPS.
const EPS_ROUNDING = 0.005;
const BUYBACK_FLOOR = 0.02;

// How far the only available weight vector may sit from the quarter before it
// stops being "as-of" and the weighted number is withheld.
const WEIGHT_STALENESS_DAYS = 120;

/** The share-count move that counts as a real buyback/dilution at this EPS. */
function buybackThreshold(eps) {
  const e = Math.abs(eps || 0);
  if (!e) return BUYBACK_FLOOR;
  return Math.max(BUYBACK_FLOOR, (2 * EPS_ROUNDING) / e);
}

const DAY = 86400000;
const days = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / DAY);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const round = (v, n = 4) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(n));

/** '2026-06' → the calendar quarter's [start, end] as ISO dates. */
function quarterBounds(quarter) {
  const [y, m] = quarter.split('-').map(Number);
  const startMonth = m - 3;
  const start = new Date(Date.UTC(y, startMonth, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}

/**
 * Growth as a percentage, or null when the base cannot carry one.
 *
 * A sign change is not a percentage: −10 → +5 is a turnaround, and rendering it
 * as "+150%" is the most common way an earnings aggregate lies.
 */
function growthPct(now, prior, { floor = 0 } = {}) {
  if (now == null || prior == null) return null;
  if (prior <= 0 || now <= 0) return null;      // crossers are classified, not divided
  if (Math.abs(prior) < floor) return null;
  return ((now / prior) - 1) * 100;
}

/** How a company crossing zero is described instead of divided. */
function classify(now, prior) {
  if (prior > 0 && now > 0) return now >= prior ? 'grew' : 'shrank';
  if (prior <= 0 && now > 0) return 'lossToProfit';
  if (prior > 0 && now <= 0) return 'profitToLoss';
  return 'lossToLoss';
}

/**
 * Pair each symbol's rows for the target quarter with a comparison period,
 * matched on elapsed days rather than row position.
 */
function pairByDate(rows, targetEnd, gapDays, tolDays) {
  let best = null;
  for (const r of rows) {
    const d = days(targetEnd, r.periodEnd);
    const off = Math.abs(d - gapDays);
    if (off > tolDays) continue;
    if (!best || off < Math.abs(days(targetEnd, best.periodEnd) - gapDays)) best = r;
  }
  return best;
}

/**
 * One symbol's profit bridge. Each step is held at the other's prior value and
 * the interaction residual is REPORTED, never absorbed into a neighbouring step
 * — absorbing it would make one driver look larger than it was.
 *
 * Financials get a different bridge entirely: interest is a lender's revenue
 * line and provisions are the swing factor, so revenue → margin → interest is
 * nonsense for a bank. The two are never relabelled into each other.
 */
function companyBridge(now, prior) {
  if (now.isFinancial || prior.isFinancial) {
    const dProvisions = -( (now.provisions ?? 0) - (prior.provisions ?? 0) );
    const dPbt = (now.pbt ?? 0) - (prior.pbt ?? 0);
    const dTax = (now.netProfit - now.pbt) - (prior.netProfit - prior.pbt);
    const steps = [
      { step: 'provisions', delta: dProvisions },
      { step: 'preProvision', delta: dPbt - dProvisions },
      { step: 'tax', delta: dTax },
    ];
    const walked = sum(steps.map(s => s.delta));
    steps.push({ step: 'residual', delta: (now.netProfit - prior.netProfit) - walked });
    return { kind: 'financial', steps };
  }

  const priorMargin = prior.revenue ? (prior.operatingProfit ?? 0) / prior.revenue : 0;
  const dRevenue = ((now.revenue ?? 0) - (prior.revenue ?? 0)) * priorMargin;
  const dMargin = (now.revenue ?? 0) *
    (((now.operatingProfit ?? 0) / (now.revenue || 1)) - priorMargin);
  const dOther = (now.otherIncome ?? 0) - (prior.otherIncome ?? 0);
  const dIntDep = -(((now.interest ?? 0) + (now.depreciation ?? 0)) -
                    ((prior.interest ?? 0) + (prior.depreciation ?? 0)));
  const priorTaxRate = prior.pbt ? 1 - prior.netProfit / prior.pbt : 0;
  const dTax = -((now.pbt ?? 0) * ((now.pbt ? 1 - now.netProfit / now.pbt : 0) - priorTaxRate));
  const steps = [
    { step: 'revenue', delta: dRevenue },
    { step: 'opm', delta: dMargin },
    { step: 'otherIncome', delta: dOther },
    { step: 'interestDep', delta: dIntDep },
    { step: 'tax', delta: dTax },
  ];
  const walked = sum(steps.map(s => s.delta));
  steps.push({ step: 'residual', delta: (now.netProfit - prior.netProfit) - walked });
  return { kind: 'industrial', steps };
}

/** Quality chips, computed from the bridge — descriptions, never scores. */
function qualityFlags(now, prior, bridge) {
  const out = [];
  const dNet = now.netProfit - prior.netProfit;
  const by = (name) => bridge.steps.find(s => s.step === name)?.delta ?? 0;

  if (dNet > 0 && by('otherIncome') > 0.5 * dNet) out.push('other-income-driven');
  if (dNet > 0 && by('tax') > 0.5 * dNet) out.push('tax-driven');
  if (now.operatingProfit != null && prior.operatingProfit != null &&
      now.operatingProfit < prior.operatingProfit && now.netProfit > prior.netProfit) {
    out.push('below-the-line');
  }

  // Share count, from the derivation valuation/engine.js already uses. The
  // threshold scales with EPS precision, or a ₹0.30-EPS stock flags a buyback
  // every quarter from rounding alone.
  const sharesNow = now.eps ? now.netProfit / now.eps : null;
  const sharesPrior = prior.eps ? prior.netProfit / prior.eps : null;
  if (sharesNow && sharesPrior && sharesPrior > 0) {
    const move = sharesNow / sharesPrior - 1;
    const threshold = Math.max(buybackThreshold(now.eps), buybackThreshold(prior.eps));
    if (move <= -threshold) out.push('buyback');
    if (move >= threshold) out.push('dilution');
  }
  return out;
}

/**
 * Aggregate one quarter for one scope.
 *
 * @param rows          stored fundamentals rows (all periods, all symbols in scope)
 * @param constituents  [{ symbol }] — deduped internally, so a symbol appearing
 *                      in two sectors or in both SPX and NDX counts once
 * @param quarter       '2026-06'
 * @param weights       { symbol: marketCap } — ONE as-of vector, both sides
 * @param weightsAsOf   ISO date of that snapshot
 * @param issuerGroups  [['GOOG','GOOGL']] — dual-class, merged not dropped
 * @param aliases       { OLD: NEW } — a rename is not a missed quarter
 */
function aggregateQuarter({
  rows = [], constituents = [], quarter,
  weights = null, weightsAsOf = null,
  issuerGroups = [], aliases = {},
} = {}) {
  const [, quarterEnd] = quarterBounds(quarter);
  const canon = (s) => aliases[s] || s;

  // Scope, deduped. Storage dedupes through the primary key; a UNION of scopes
  // does not, so it has to happen here before anything is summed.
  const scope = [...new Set(constituents.map(c => canon(c.symbol)))];

  // symbol -> quarterly rows, ascending, with renames folded together.
  const bySymbol = new Map();
  for (const r of rows) {
    if (r.periodType && r.periodType !== 'quarter') continue;
    const s = canon(r.symbol);
    if (!bySymbol.has(s)) bySymbol.set(s, []);
    bySymbol.get(s).push({ ...r, symbol: s });
  }
  for (const list of bySymbol.values()) list.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));

  // Dual-class: financials are ONE company's, so they are counted once — but the
  // caps are SUMMED, because dropping a row before weighting would leave the
  // issuer carrying half its true index weight.
  const primaryOf = new Map();
  for (const group of issuerGroups) {
    const present = group.map(canon).filter(s => scope.includes(s));
    if (present.length < 2) continue;
    const [primary, ...rest] = present;
    for (const s of rest) primaryOf.set(s, primary);
  }
  const mergedWeight = (symbol) => {
    if (!weights) return null;
    let w = weights[symbol] ?? 0;
    for (const [dupe, primary] of primaryOf) if (primary === symbol) w += weights[dupe] ?? 0;
    return w;
  };

  const excluded = [];
  const reporting = [];
  const pairs = [];   // one per counted issuer

  for (const symbol of scope) {
    const list = bySymbol.get(symbol) || [];
    const current = list.find(r => r.periodEnd >= quarterBounds(quarter)[0] && r.periodEnd <= quarterEnd);

    reporting.push({
      symbol,
      periodEnd: current ? current.periodEnd : null,
      reported: Boolean(current),
      backfilled: current ? Boolean(current.backfilled) : null,
      seenOn: null,               // filled by the caller's reporting-lag band
      mergedInto: primaryOf.get(symbol) || null,
    });

    if (!current) continue;                       // not reported yet — same-store
    if (primaryOf.has(symbol)) continue;          // counted under its primary

    const yoy = pairByDate(list, current.periodEnd, YOY_DAYS, YOY_TOL_DAYS);
    const qoq = pairByDate(list, current.periodEnd, QOQ_DAYS, QOQ_TOL_DAYS);

    if (!yoy) { excluded.push({ symbol, reason: 'no-yoy-match' }); continue; }
    // Storing `basis` is not the same as checking it: a standalone-to-
    // consolidated switch invents growth out of an accounting change.
    if (yoy.basis !== current.basis) { excluded.push({ symbol, reason: 'basis-mismatch' }); continue; }
    if (yoy.unit !== current.unit) { excluded.push({ symbol, reason: 'unit-mismatch' }); continue; }

    pairs.push({ symbol, current, yoy, qoq, weight: mergedWeight(symbol) });
  }

  const unit = pairs[0]?.current.unit ?? rows[0]?.unit ?? null;

  // ── Coverage: two numbers, both of which must clear ────────────────────────
  const yearAgoPoolAll = sum(scope
    .filter(s => !primaryOf.has(s))
    .map(s => {
      const list = bySymbol.get(s) || [];
      const target = new Date(Date.parse(quarterEnd) - YOY_DAYS * DAY).toISOString().slice(0, 10);
      const r = pairByDate(list, quarterEnd, YOY_DAYS, YOY_TOL_DAYS) ||
                list.find(x => Math.abs(days(target, x.periodEnd)) <= YOY_TOL_DAYS);
      return r ? Math.max(r.netProfit, 0) : 0;
    }));
  const reportedPool = sum(pairs.map(p => Math.max(p.yoy.netProfit, 0)));
  const constituentCount = scope.filter(s => !primaryOf.has(s)).length;
  const countPct = constituentCount ? (pairs.length / constituentCount) * 100 : 0;
  const poolPct = yearAgoPoolAll ? (reportedPool / yearAgoPoolAll) * 100 : 0;
  const sufficient = countPct >= MIN_COUNT_COVERAGE_PCT && poolPct >= MIN_POOL_COVERAGE_PCT;

  // ── Per-company growth, with the peer-relative base floor ─────────────────
  const bases = pairs.map(p => Math.abs(p.yoy.netProfit)).filter(v => v > 0);
  const baseFloor = BASE_FLOOR_FRACTION * (median(bases) ?? 0);
  const eligible = [];
  for (const p of pairs) {
    if (Math.abs(p.yoy.netProfit) < baseFloor) {
      excluded.push({ symbol: p.symbol, reason: 'base-below-floor' });
      continue;
    }
    eligible.push(p);
  }

  /** Build one period-comparison block (YoY, QoQ, TTM, FY all share this shape). */
  const block = (list, priorOf) => {
    const usable = list.filter(p => priorOf(p));
    if (!usable.length) return null;
    const now = sum(usable.map(p => p.current.netProfit));
    const prior = sum(usable.map(p => priorOf(p).netProfit));
    const gross = sum(usable.map(p => Math.abs(priorOf(p).netProfit)));
    // The pool's own base can be negative or a near-cancellation; company-level
    // sign handling does not cover it.
    const poolUsable = prior > 0 && gross > 0 && prior / gross >= POOL_NET_TO_GROSS_FLOOR;
    const growths = usable
      .filter(p => Math.abs(priorOf(p).netProfit) >= baseFloor)
      .map(p => growthPct(p.current.netProfit, priorOf(p).netProfit))
      .filter(v => v != null);
    return {
      poolGrowthPct: poolUsable ? round(((now / prior) - 1) * 100, 6) : null,
      poolDeltaAbs: round(now - prior, 6),
      medianGrowthPct: round(median(growths), 6),
      iqr: growths.length >= 4
        ? round(quantile(growths, 0.75) - quantile(growths, 0.25), 6) : null,
      weightedGrowthPct: null,   // filled below, only with an as-of weight vector
      n: growths.length,         // companies behind the median, not the same-store count
      poolUsable,
    };
  };

  const yoyBlock = block(pairs, p => p.yoy) ||
    { poolGrowthPct: null, poolDeltaAbs: null, medianGrowthPct: null, iqr: null,
      weightedGrowthPct: null, n: 0, poolUsable: false };
  const qoqBlock = block(pairs.filter(p => p.qoq), p => p.qoq);

  // ── The weighted ratio: ΣwEPS(t) ÷ ΣwEPS(t-4), one vector on both sides ────
  let weightNote = null;
  if (!weights) {
    weightNote = 'No market-cap snapshot supplied, so no weighted number.';
  } else if (!weightsAsOf) {
    weightNote = 'Weight vector has no as-of date, so it cannot be shown to be contemporaneous.';
  } else if (Math.abs(days(weightsAsOf, quarterEnd)) > WEIGHT_STALENESS_DAYS) {
    weightNote = `This quarter predates the weight snapshot era — the nearest vector is ${Math.abs(days(weightsAsOf, quarterEnd))} days away, so no as-of weight exists for it.`;
  } else {
    const usable = pairs.filter(p => p.current.eps != null && p.yoy.eps != null && p.weight);
    if (usable.length) {
      const now = sum(usable.map(p => p.weight * p.current.eps));
      const prior = sum(usable.map(p => p.weight * p.yoy.eps));
      if (prior > 0) yoyBlock.weightedGrowthPct = round(((now / prior) - 1) * 100, 6);
    }
    if (yoyBlock.weightedGrowthPct == null) weightNote = 'Not enough EPS coverage to weight.';
  }

  // ── TTM and FY ────────────────────────────────────────────────────────────
  const ttm = buildTtm(pairs, bySymbol, quarterEnd);
  const fy = buildFy(rows, scope, primaryOf, quarter);

  // ── Breadth — same-store, because classification needs both periods ────────
  const breadth = { grew: 0, shrank: 0, lossToProfit: 0, profitToLoss: 0, lossToLoss: 0 };
  for (const p of pairs) breadth[classify(p.current.netProfit, p.yoy.netProfit)]++;

  // ── Contributions: sum EXACTLY to pool growth, which is the whole point ────
  const poolPrior = sum(pairs.map(p => p.yoy.netProfit));
  const contributions = pairs
    .map(p => ({
      symbol: p.symbol,
      delta: round(p.current.netProfit - p.yoy.netProfit, 6),
      sharePct: yoyBlock.poolUsable
        ? ((p.current.netProfit - p.yoy.netProfit) / poolPrior) * 100 : null,
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // ── The sector bridge is the Σ of the same-store company bridges ───────────
  const bridgeMap = new Map();
  let bridgeKind = 'industrial';
  let anyFinancial = false;
  const flags = {};
  for (const p of pairs) {
    const b = companyBridge(p.current, p.yoy);
    if (b.kind === 'financial') anyFinancial = true;
    for (const s of b.steps) bridgeMap.set(s.step, (bridgeMap.get(s.step) ?? 0) + s.delta);
    const f = qualityFlags(p.current, p.yoy, b);
    if (f.length) flags[p.symbol] = f;
  }
  if (anyFinancial) bridgeKind = pairs.every(p => p.current.isFinancial) ? 'financial' : 'mixed';
  const bridge = [...bridgeMap.entries()].map(([step, delta]) => ({
    step,
    delta: round(delta, 6),
    pctOfChange: poolPrior ? round((delta / Math.abs(poolPrior)) * 100, 6) : null,
  }));

  const bridgeNote = bridgeKind === 'financial'
    ? 'Lender bridge: interest is a revenue line and provisions are the swing factor, so the operating-margin steps do not apply.'
    : bridgeKind === 'mixed'
      ? 'This scope mixes lenders and operating companies, so the bridge sums two different decompositions — read the constituent bridges instead.'
      : null;

  return {
    quarter,
    unit,
    yoy: yoyBlock,
    qoq: qoqBlock && { ...qoqBlock, caveat: 'Sequential growth is seasonal for most businesses — read it next to YoY, never alone.' },
    ttm,
    fy,
    bridge,
    bridgeKind,
    bridgeNote,
    bridgeBase: round(poolPrior, 6),
    bridgeClose: round(sum(pairs.map(p => p.current.netProfit)), 6),
    contributions,
    flags,
    breadth,
    surprise: null,          // Phase 3 — forward-only, see the plan
    coverage: {
      reportedCount: pairs.length,
      constituents: constituentCount,
      countPct: round(countPct, 4),
      poolPct: round(poolPct, 4),
      sufficient,
    },
    reporting,
    excluded,
    weightNote,
    verdict: verdict({ sufficient, yoyBlock, pairs, constituentCount, unit }),
  };
}

/** Trailing four quarters vs the four before, gated on SPACING not on count. */
function buildTtm(pairs, bySymbol, quarterEnd) {
  const usable = [];
  for (const p of pairs) {
    const list = (bySymbol.get(p.symbol) || []).filter(r => r.periodEnd <= p.current.periodEnd);
    const window = list.slice(-TTM_QUARTERS);
    if (window.length < TTM_QUARTERS) return null;
    for (let i = 1; i < window.length; i++) {
      if (days(window[i].periodEnd, window[i - 1].periodEnd) > TTM_MAX_GAP_DAYS) return null;
    }
    usable.push({
      now: sum(window.slice(4).map(r => r.netProfit)),
      prior: sum(window.slice(0, 4).map(r => r.netProfit)),
    });
  }
  if (!usable.length) return null;
  const now = sum(usable.map(u => u.now));
  const prior = sum(usable.map(u => u.prior));
  const gross = sum(usable.map(u => Math.abs(u.prior)));
  const poolUsable = prior > 0 && gross > 0 && prior / gross >= POOL_NET_TO_GROSS_FLOOR;
  const growths = usable.map(u => growthPct(u.now, u.prior)).filter(v => v != null);
  return {
    poolGrowthPct: poolUsable ? round(((now / prior) - 1) * 100, 6) : null,
    poolDeltaAbs: round(now - prior, 6),
    medianGrowthPct: round(median(growths), 6),
    iqr: null,
    weightedGrowthPct: null,
    n: growths.length,
    poolUsable,
  };
}

/** Latest annual pair, when both years are present for enough of the scope. */
function buildFy(rows, scope, primaryOf, quarter) {
  const annual = rows.filter(r => r.periodType === 'annual');
  if (!annual.length) return null;
  const year = Number(quarter.slice(0, 4));
  const usable = [];
  for (const symbol of scope) {
    if (primaryOf.has(symbol)) continue;
    const mine = annual.filter(r => r.symbol === symbol);
    const now = mine.find(r => Number(r.periodEnd.slice(0, 4)) === year);
    const prior = mine.find(r => Number(r.periodEnd.slice(0, 4)) === year - 1);
    if (now && prior && now.basis === prior.basis && now.unit === prior.unit) {
      usable.push({ now: now.netProfit, prior: prior.netProfit });
    }
  }
  if (!usable.length) return null;
  const now = sum(usable.map(u => u.now));
  const prior = sum(usable.map(u => u.prior));
  const gross = sum(usable.map(u => Math.abs(u.prior)));
  const poolUsable = prior > 0 && gross > 0 && prior / gross >= POOL_NET_TO_GROSS_FLOOR;
  const growths = usable.map(u => growthPct(u.now, u.prior)).filter(v => v != null);
  return {
    poolGrowthPct: poolUsable ? round(((now / prior) - 1) * 100, 6) : null,
    poolDeltaAbs: round(now - prior, 6),
    medianGrowthPct: round(median(growths), 6),
    iqr: null,
    weightedGrowthPct: null,
    n: growths.length,
    poolUsable,
  };
}

/**
 * A template with slots, never free text.
 *
 * An open-ended verdict field invites interpretive labels — "strong quarter",
 * "sector accelerating" — and this module is a description of the past with no
 * track record behind it. Every branch below states a measurement or states
 * that it is declining to.
 */
function verdict({ sufficient, yoyBlock, pairs, constituentCount, unit }) {
  if (!pairs.length) return 'No constituent has reported this quarter yet.';
  if (!sufficient) {
    return `Too little coverage to judge: ${pairs.length} of ${constituentCount} reported.`;
  }
  const n = `${pairs.length} of ${constituentCount} reported`;
  if (yoyBlock.poolGrowthPct == null) {
    return `Profit pool moved ${yoyBlock.poolDeltaAbs} ${unit || ''} year on year; the year-ago base is too close to zero for a percentage (${n}).`.replace(/\s+/g, ' ');
  }
  return `Profit pool ${yoyBlock.poolGrowthPct >= 0 ? '+' : ''}${round(yoyBlock.poolGrowthPct, 2)}% year on year, median company ${yoyBlock.medianGrowthPct == null ? 'n/a' : `${yoyBlock.medianGrowthPct >= 0 ? '+' : ''}${round(yoyBlock.medianGrowthPct, 2)}%`} (${n}).`;
}

module.exports = {
  aggregateQuarter,
  buybackThreshold, growthPct, classify, companyBridge, pairByDate, quarterBounds,
  MIN_COUNT_COVERAGE_PCT, MIN_POOL_COVERAGE_PCT,
  BASE_FLOOR_FRACTION, POOL_NET_TO_GROSS_FLOOR,
  YOY_DAYS, QOQ_DAYS, TTM_QUARTERS, TTM_MAX_GAP_DAYS,
};
