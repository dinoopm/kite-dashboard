// Valuation assessment engine — pure computation over already-fetched inputs.
// Four independent lenses (peers / own history / growth-adjusted / intrinsic),
// each degrading to status:'insufficient' on missing data, plus a composite
// verdict. Deliberately assumption-light: no DCF — multiples, history bands,
// PEG, earnings-yield-vs-risk-free, Graham number, and FCF yield only.
//
// Unit conventions: screener values are ₹ Cr; prices are ₹; Yahoo raw values
// are converted by the caller where noted.

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(1));

// Compound annual growth across n years; null when endpoints are unusable
// (CAGR from a non-positive base is undefined).
function cagr(first, last, years) {
  if (first == null || last == null || first <= 0 || last <= 0 || years <= 0) return null;
  return (Math.pow(last / first, 1 / years) - 1) * 100;
}

// Implied share count (Cr) per year from netProfit (₹Cr) / EPS (₹). Used both
// for BVPS and to detect split/bonus share-base shifts that would poison a
// historical P/E comparison.
function impliedSharesSeries(annualYears) {
  return (annualYears || [])
    .map(y => (y.netProfit != null && y.eps != null && y.eps !== 0 && Math.sign(y.netProfit) === Math.sign(y.eps))
      ? { label: y.label, shares: Math.abs(y.netProfit / y.eps) }
      : null)
    .filter(Boolean);
}

function computeValuation({
  symbol,
  price,                 // current price ₹
  riskFreeRate,          // repo rate %, may be null
  yahoo = {},            // { trailingPE, forwardPE, priceToBook, marketCapCr, sharesOutstandingCr, roePct, dividendYieldPct }
  peerMedian = null,     // { pe, roce, peerCount?, q1?, q3? } — hygienic median (self excluded) from the endpoint
  peerSelf = null,       // own row from the screener peers table
  annualYears = [],      // [{ label:'FY24', sortKey:2024, eps, netProfit, totalIncome, otherIncome, pbt, operatingProfit }] ASC
  ttmEps = null,         // sum of the last 4 quarterly EPS (screener basis), null if unavailable
  netWorthYears = [],    // [{ fyLabel, fy, netWorth }] ASC
  fcfYears = [],         // [{ fyLabel, freeCashFlow }] ASC
  candles = [],          // daily candles ASC (≈4y) for the history band
  isFinancial = false,   // bank/NBFC: deposits/loans on the balance sheet
  debtCr = null,         // latest borrowings ₹Cr (screener balance sheet)
  isCyclical = false,    // industry is commodity/cyclical (endpoint keyword match)
  sizeMismatchRatio = null, // own market cap ÷ peer-median market cap
}) {
  const caveats = [];

  const latestAnnual = annualYears[annualYears.length - 1] || null;
  const epsLatest = latestAnnual?.eps ?? null;
  // TTM (trailing 4 quarters) is the freshest denominator; FY EPS goes stale
  // for up to a year between annual reports.
  const epsForPE = ttmEps ?? epsLatest;
  const lossMaking = epsForPE != null && epsForPE <= 0;

  // Earnings-quality screen: when other income dominates pre-tax profit, the
  // P/E denominator isn't operating earnings — "cheap" P/E claims can't be
  // trusted (SIGMAADV-style: ₹201 Cr NP on ₹19 Cr operating profit).
  // (Caveat text is pushed AFTER the downgrade pass below, so the wording can
  // reflect whether anything was actually downgraded.)
  let lowEarningsQuality = false;
  let oiSharePct = null;
  if (latestAnnual?.pbt != null && latestAnnual.pbt > 0 && latestAnnual?.otherIncome != null) {
    const oiShare = latestAnnual.otherIncome / latestAnnual.pbt;
    if (oiShare > 0.3) {
      lowEarningsQuality = true;
      oiSharePct = Math.round(oiShare * 100);
    }
  }

  // Shares outstanding (Cr): Yahoo first, implied from netProfit/EPS second.
  const impliedSeries = impliedSharesSeries(annualYears);
  const impliedLatest = impliedSeries.length ? impliedSeries[impliedSeries.length - 1].shares : null;
  const sharesCr = yahoo.sharesOutstandingCr ?? impliedLatest;

  // Current P/E: trailing-4-quarter EPS (screener basis, freshest) first,
  // Yahoo TTM second, latest FY EPS last.
  let currentPE = null;
  let peBasis = null;
  if (price != null && ttmEps != null && ttmEps > 0) {
    currentPE = price / ttmEps;
    peBasis = `TTM, last 4 quarters (₹${+ttmEps.toFixed(2)})`;
  } else if (yahoo.trailingPE != null) {
    currentPE = yahoo.trailingPE;
    peBasis = 'TTM (Yahoo)';
  } else if (price != null && epsLatest != null && epsLatest > 0) {
    currentPE = price / epsLatest;
    peBasis = `FY EPS (₹${epsLatest})`;
  }
  if (lossMaking) {
    currentPE = null;
    peBasis = null;
    caveats.push('Trailing EPS is zero/negative — P/E-based lenses are not meaningful for a loss-making company.');
  }

  const marketCapCr = yahoo.marketCapCr
    ?? ((price != null && sharesCr != null) ? price * sharesCr : null);

  if (isFinancial) {
    caveats.push('Bank/NBFC balance sheet detected — P/E and FCF metrics mislead for lenders; weight P/B and ROE instead.');
  }
  if (sizeMismatchRatio != null && sizeMismatchRatio > 10) {
    caveats.push(`Market cap is ${Math.round(sizeMismatchRatio)}× the peer median — the screener industry table may not be a comparable set (conglomerate / segment mismatch); read the peers premium with skepticism.`);
  }

  // Cycle-adjusted P/E (Shiller-lite): price ÷ average of the last ≤5 FY EPS.
  // For cyclicals, trailing P/E inverts at cycle extremes — cheapest-looking
  // at peak earnings — so cheapness claims must clear the through-cycle bar.
  let cycleAdjustedPE = null;
  {
    const last5 = annualYears.slice(-5).map(y => y.eps).filter(v => v != null);
    if (last5.length >= 3) {
      const avg = last5.reduce((s, v) => s + v, 0) / last5.length;
      if (avg > 0 && price != null) cycleAdjustedPE = price / avg;
    }
  }
  if (isCyclical) {
    caveats.push('Cyclical/commodity industry — trailing P/E is unreliable at cycle extremes; the cycle-adjusted P/E (price ÷ 5-yr average EPS) is the better anchor here.');
  }

  // ── Lens 1: Relative (vs industry peers) ────────────────────────
  // Own P/E comes from the SAME screener industry table as the median when
  // available (peerSelf.pe) — identical EPS basis on both sides. The blended
  // currentPE is only a fallback.
  let peers = { status: 'insufficient', signal: null };
  {
    const ownPE = (peerSelf?.pe != null && peerSelf.pe > 0 && !lossMaking) ? peerSelf.pe : currentPE;
    const ownPEBasis = (peerSelf?.pe != null && peerSelf.pe > 0 && !lossMaking) ? 'screener peers table' : peBasis;
    if (ownPE != null && peerMedian?.pe != null && peerMedian.pe > 0) {
      const premiumPct = ((ownPE / peerMedian.pe) - 1) * 100;
      const signal = premiumPct > 25 ? 'expensive' : premiumPct < -25 ? 'cheap' : 'fair';
      peers = {
        status: 'ok',
        signal,
        currentPE: r2(ownPE),
        peBasis: ownPEBasis,
        medianPE: r2(peerMedian.pe),
        peerCount: peerMedian.peerCount ?? null,
        peIqr: (peerMedian.q1 != null && peerMedian.q3 != null) ? [r2(peerMedian.q1), r2(peerMedian.q3)] : null,
        premiumPct: r1(premiumPct),
        roce: r1(peerSelf?.roce ?? null),
        medianRoce: r1(peerMedian.roce ?? null),
        // Tri-state with a ±0.5pp tolerance band: raw-float >= comparisons
        // produced "23.5% vs 23.5% but below median" artifacts when values
        // differed only past the displayed precision.
        roceVsMedian: (peerSelf?.roce != null && peerMedian.roce != null)
          ? (peerSelf.roce - peerMedian.roce > 0.5 ? 'above'
            : peerMedian.roce - peerSelf.roce > 0.5 ? 'below'
            : 'inline')
          : null,
      };
    } else if (peerMedian?.reason) {
      peers = { status: 'insufficient', signal: null, reason: peerMedian.reason };
    } else if (lossMaking && peerMedian?.pe != null) {
      peers = { status: 'insufficient', signal: null, reason: 'No meaningful P/E (loss-making)', medianPE: r2(peerMedian.pe) };
    }
  }

  // ── Lens 2: Historical (vs own P/E band) ────────────────────────
  // FY-end price ÷ that FY's EPS, for FYs where the candle cache overlaps.
  let history = { status: 'insufficient', signal: null };
  const shiftDetected = (() => {
    if (impliedSeries.length < 2) return false;
    const vals = impliedSeries.map(s => s.shares);
    return Math.max(...vals) / Math.min(...vals) > 1.6;
  })();
  if (shiftDetected) {
    caveats.push('Implied share base shifted >60% across years (split/bonus/dilution) — historical P/E band suppressed as unreliable.');
  } else if (candles.length > 0 && annualYears.length > 0) {
    // EPS in force at a given date = the last COMPLETED fiscal year's EPS
    // (FY ends March 31). Same screener basis as the current marker below.
    const fyEps = annualYears.filter(y => y.eps != null && y.eps > 0 && y.sortKey);
    const epsAsOf = (iso) => {
      let best = null;
      for (const y of fyEps) { if (`${y.sortKey}-03-31` <= iso) best = y.eps; }
      return best;
    };

    // Monthly sampling (last trading day of each month) — a 4-year candle
    // window yields ~48 observations, enough for a meaningful percentile
    // (FY-end-only sampling gave n≈5, statistically an anecdote).
    const monthly = [];
    for (let i = 0; i < candles.length; i++) {
      const d = String(candles[i].date).slice(0, 10);
      const nextMonth = i + 1 < candles.length ? String(candles[i + 1].date).slice(0, 7) : null;
      if (nextMonth === d.slice(0, 7)) continue; // not its month's last trading day
      const eps = epsAsOf(d);
      if (eps != null) monthly.push({ date: d, pe: +(candles[i].close / eps).toFixed(2) });
    }

    // FY-end snapshots kept for the readable caption in the UI.
    const fyPoints = [];
    {
      const firstCandleDate = String(candles[0].date).slice(0, 10);
      const closeOnOrBefore = (iso) => {
        let best = null;
        for (const c of candles) {
          const d = String(c.date).slice(0, 10);
          if (d <= iso) best = c.close; else break;
        }
        return best;
      };
      for (const y of fyEps) {
        const fyEnd = `${y.sortKey}-03-31`;
        if (fyEnd < firstCandleDate) continue;
        const px = closeOnOrBefore(fyEnd);
        if (px != null) fyPoints.push({ label: y.label, pe: +(px / y.eps).toFixed(2) });
      }
    }

    // Current marker on the SAME screener-EPS basis as the band (TTM extends
    // the FY series naturally — TTM at FY-end equals FY EPS).
    const epsForBand = (ttmEps != null && ttmEps > 0) ? ttmEps : epsLatest;
    const basisPE = (price != null && epsForBand != null && epsForBand > 0) ? price / epsForBand : null;
    const sample = monthly.length >= 12 ? monthly : (fyPoints.length >= 3 ? fyPoints : null);
    if (sample && basisPE != null) {
      const pes = sample.map(p => p.pe).concat(basisPE);
      const min = Math.min(...pes);
      const max = Math.max(...pes);
      const below = pes.filter(v => v < basisPE).length;
      const percentile = Math.round((below / pes.length) * 100);
      const signal = percentile >= 75 ? 'expensive' : percentile <= 25 ? 'cheap' : 'fair';
      history = {
        status: 'ok', signal,
        sampleCount: sample.length,
        sampling: sample === monthly ? 'monthly' : 'FY-end',
        fyPoints,
        currentPE: r2(basisPE),
        peBasis: (ttmEps != null && ttmEps > 0) ? 'price ÷ TTM EPS (screener)' : 'price ÷ latest FY EPS (screener)',
        cycleAdjustedPE: r2(cycleAdjustedPE),
        min: r2(min), max: r2(max), percentile,
      };
    }
  }

  // ── Lens 3: Growth-adjusted ─────────────────────────────────────
  let growth = { status: 'insufficient', signal: null };
  {
    const epsAt = (back) => annualYears.length > back ? annualYears[annualYears.length - 1 - back]?.eps : null;
    const revAt = (back) => annualYears.length > back ? annualYears[annualYears.length - 1 - back]?.totalIncome : null;
    const epsCagr3y = cagr(epsAt(3), epsAt(0), 3);
    const epsCagr5y = cagr(epsAt(5), epsAt(0), 5);
    const revenueCagr3y = cagr(revAt(3), revAt(0), 3);
    const peg = (currentPE != null && epsCagr3y != null && epsCagr3y > 0) ? currentPE / epsCagr3y : null;
    const earningsYield = currentPE != null && currentPE > 0 ? 100 / currentPE : null;
    // Equities are long-duration: anchor against a 10Y G-sec PROXY (repo +
    // ~120bps term premium), not the overnight policy rate, which flattered
    // every stock by ~1pp. No equity risk premium is applied — stated in UI.
    const tenYearProxy = riskFreeRate != null ? riskFreeRate + 1.2 : null;

    if (peg != null || earningsYield != null) {
      let signal = 'fair';
      if (peg != null) signal = peg < 1 ? 'cheap' : peg > 2 ? 'expensive' : 'fair';
      else if (earningsYield != null && tenYearProxy != null) {
        signal = earningsYield > tenYearProxy + 1 ? 'cheap' : earningsYield < tenYearProxy - 1 ? 'expensive' : 'fair';
      }
      growth = {
        status: 'ok', signal,
        epsCagr3y: r1(epsCagr3y), epsCagr5y: r1(epsCagr5y), revenueCagr3y: r1(revenueCagr3y),
        peg: r2(peg),
        earningsYield: r1(earningsYield),
        forwardPE: r2(yahoo.forwardPE ?? null),
        policyRate: r2(riskFreeRate),
        tenYearProxy: r2(tenYearProxy),
        yieldGap: (earningsYield != null && tenYearProxy != null) ? r1(earningsYield - tenYearProxy) : null,
      };
    }
  }

  // ── Lens 4: Intrinsic (rough anchors, clearly labeled) ──────────
  let intrinsic = { status: 'insufficient', signal: null };
  {
    const latestNW = netWorthYears.length ? netWorthYears[netWorthYears.length - 1] : null;
    const bvps = (latestNW?.netWorth != null && sharesCr != null && sharesCr > 0)
      ? latestNW.netWorth / sharesCr
      : null;
    const pb = yahoo.priceToBook ?? ((price != null && bvps != null && bvps > 0) ? price / bvps : null);
    const graham = (epsLatest != null && epsLatest > 0 && bvps != null && bvps > 0)
      ? Math.sqrt(22.5 * epsLatest * bvps)
      : null;
    const grahamUpsidePct = (graham != null && price != null && price > 0) ? ((graham / price) - 1) * 100 : null;
    const latestFcf = fcfYears.length ? fcfYears[fcfYears.length - 1]?.freeCashFlow : null;
    const fcfYieldPct = (latestFcf != null && marketCapCr != null && marketCapCr > 0)
      ? (latestFcf / marketCapCr) * 100
      : null;

    // Leverage context — a cheap P/E on a levered balance sheet is not the
    // same animal as a cheap P/E on net cash. D/E uses gross borrowings
    // (screener has no cash row); skipped for banks where it's meaningless.
    const debtToEquity = (!isFinancial && debtCr != null && latestNW?.netWorth != null && latestNW.netWorth > 0)
      ? debtCr / latestNW.netWorth
      : null;
    if (debtToEquity != null && debtToEquity > 1.5) {
      caveats.push(`High leverage: gross debt is ${debtToEquity.toFixed(1)}× net worth — P/E understates enterprise-level valuation; weight EV/EBITDA.`);
    }

    // Justified P/B via residual income: (ROE − g)/(r − g). Replaces the
    // 1949-vintage Graham number as the SIGNAL (Graham stays as a displayed
    // footnote heuristic). r = 10Y proxy + 5pp equity risk premium; g = long-
    // run growth clamped to [2%, 6%] (no business compounds above nominal GDP
    // forever). All assumptions exposed in the payload.
    let justifiedPB = null;
    let pbVsJustified = null;
    const roe = yahoo.roePct ?? null;
    const rCoE = riskFreeRate != null ? riskFreeRate + 1.2 + 5.0 : null;
    let gLT = null;
    {
      const epsAt = (back) => annualYears.length > back ? annualYears[annualYears.length - 1 - back]?.eps : null;
      const g5 = cagr(epsAt(5), epsAt(0), 5);
      const g3 = cagr(epsAt(3), epsAt(0), 3);
      gLT = Math.min(6, Math.max(2, g5 ?? g3 ?? 4));
    }
    if (roe != null && rCoE != null && rCoE > gLT) {
      const jpb = (roe - gLT) / (rCoE - gLT);
      if (jpb > 0) {
        justifiedPB = jpb;
        if (pb != null) pbVsJustified = pb / jpb;
      }
    }

    if (pb != null || graham != null || fcfYieldPct != null || justifiedPB != null) {
      let signal = 'fair';
      let signalBasis = null;
      if (pbVsJustified != null) {
        signal = pbVsJustified < 0.75 ? 'cheap' : pbVsJustified > 1.5 ? 'expensive' : 'fair';
        signalBasis = 'justified P/B (residual income)';
      } else if (grahamUpsidePct != null) {
        signal = grahamUpsidePct > 15 ? 'cheap' : grahamUpsidePct < -33 ? 'expensive' : 'fair';
        signalBasis = 'Graham number';
      } else if (pb != null && isFinancial) {
        signal = pb < 1 ? 'cheap' : pb > 3 ? 'expensive' : 'fair';
        signalBasis = 'P/B (financial)';
      }
      intrinsic = {
        status: 'ok', signal, signalBasis,
        bvps: r2(bvps), pb: r2(pb),
        justifiedPB: r2(justifiedPB),
        pbVsJustified: r2(pbVsJustified),
        coeAssumptions: rCoE != null ? { costOfEquity: r2(rCoE), growth: r2(gLT), erp: 5.0 } : null,
        grahamNumber: r2(graham), grahamUpsidePct: r1(grahamUpsidePct),
        fcfYieldPct: r1(fcfYieldPct),
        evEbitda: r2(yahoo.evToEbitda ?? null),
        debtToEquity: r2(debtToEquity),
        marketCapCr: r2(marketCapCr),
        roePct: r1(roe),
        balanceSheetYear: latestNW?.fyLabel ?? null,
      };
    }
  }

  // ── Lens 5: Reverse DCF (plausibility test) ─────────────────────
  // Deliberately NOT a forward DCF: a single "fair value" swings ±30% on
  // assumptions nobody can defend. Instead, solve for the 10-yr FCF growth
  // the CURRENT price implies and compare it against delivered growth. The
  // sensitivity range (r ±1pp × g ±2pp, anchored on delivered growth) is
  // shown as a range, never a point estimate.
  let dcf = { status: 'insufficient', signal: null };
  {
    const HORIZON = 10;
    const gTermPct = 4; // long-run nominal terminal growth
    const rCoEPct = riskFreeRate != null ? riskFreeRate + 1.2 + 5.0 : null; // 10Y proxy + 5pp ERP
    const fcfs = fcfYears.map(y => y.freeCashFlow).filter(v => v != null);

    if (isFinancial) {
      dcf.reason = 'FCF-based DCF is not meaningful for banks/NBFCs (lending is the balance sheet).';
    } else if (fcfs.length < 5) {
      dcf.reason = `Needs ≥5 years of FCF history (have ${fcfs.length}).`;
    } else if (rCoEPct == null || marketCapCr == null || marketCapCr <= 0) {
      dcf.reason = 'Missing cost-of-equity anchor or market cap.';
    } else {
      const base = fcfs.slice(-3).reduce((s, v) => s + v, 0) / 3; // through-cycle base
      const last5 = fcfs.slice(-5);
      const mean5 = last5.reduce((s, v) => s + v, 0) / 5;
      const sd5 = Math.sqrt(last5.reduce((s, v) => s + (v - mean5) ** 2, 0) / 5);
      const cv = mean5 !== 0 ? Math.abs(sd5 / mean5) : Infinity;

      if (base <= 0) {
        dcf.reason = '3-yr average FCF is negative — a growth-DCF on negative cash flow is meaningless.';
      } else if (cv > 1.5) {
        dcf.reason = 'FCF is too volatile (CV > 1.5 over 5 yrs) for a stable-growth model.';
      } else {
        const r = rCoEPct / 100;
        const gT = gTermPct / 100;
        const pvAt = (rr, g) => {
          let v = 0, cf = base;
          for (let t = 1; t <= HORIZON; t++) { cf *= (1 + g); v += cf / Math.pow(1 + rr, t); }
          v += (cf * (1 + gT)) / (rr - gT) / Math.pow(1 + rr, HORIZON);
          return v;
        };

        // Solve PV(g) = market cap by bisection over [-20%, +40%].
        let implied;
        if (pvAt(r, -0.20) >= marketCapCr) implied = -0.20;
        else if (pvAt(r, 0.40) <= marketCapCr) implied = 0.40;
        else {
          let lo = -0.20, hi = 0.40;
          for (let i = 0; i < 60; i++) {
            const mid = (lo + hi) / 2;
            if (pvAt(r, mid) < marketCapCr) lo = mid; else hi = mid;
          }
          implied = (lo + hi) / 2;
        }
        const impliedPct = implied * 100;

        // Delivered growth, smoothed: 3-yr average vs the 3-yr average five
        // years earlier (point-to-point FCF CAGR is too noisy to anchor on).
        let histPct = null;
        if (fcfs.length >= 8) {
          const early = fcfs.slice(-8, -5).reduce((s, v) => s + v, 0) / 3;
          if (early > 0 && base > 0) histPct = cagr(early, base, 5);
        }

        // Asymmetric thresholds: pricing-in an acceleration is the dangerous
        // side, so the expensive bar (+5pp) is wider than the cheap bar (−3pp).
        let signal = 'fair';
        if (histPct != null) {
          signal = impliedPct < histPct - 3 ? 'cheap' : impliedPct > histPct + 5 ? 'expensive' : 'fair';
        }

        // Per-share value range across r ±1pp × growth ±2pp, anchored on
        // delivered growth (clamped to [0%, 20%]).
        let valueRange = null;
        if (sharesCr != null && sharesCr > 0) {
          // Anchor on delivered growth, clamped to [0%, 20%] AND below the
          // cost of equity (a constant-growth model can't represent g ≥ r —
          // without this clamp the mid landed OUTSIDE the low–high range).
          const gAnchor = Math.min(r - 0.015, Math.min(0.20, Math.max(0, (histPct ?? impliedPct) / 100)));
          const vals = [];
          for (const dr of [-1, 0, 1]) {
            for (const dg of [-2, 0, 2]) {
              const rr = (rCoEPct + dr) / 100;
              const gg = Math.min(rr - 0.015, gAnchor + dg / 100); // keep g < r
              vals.push(pvAt(rr, gg) / sharesCr);
            }
          }
          valueRange = {
            low: r2(Math.min(...vals)),
            mid: r2(pvAt(r, gAnchor) / sharesCr),
            high: r2(Math.max(...vals)),
            anchorGrowthPct: r1(gAnchor * 100),
            anchorClamped: histPct != null && gAnchor * 100 < histPct - 0.05,
          };
        }

        dcf = {
          status: 'ok', signal,
          impliedGrowthPct: r1(impliedPct),
          impliedCapped: implied <= -0.20 || implied >= 0.40,
          historicalFcfCagr5y: r1(histPct),
          baseFcfCr: r2(base),
          valueRange,
          assumptions: { costOfEquity: r2(rCoEPct), terminalGrowthPct: gTermPct, horizonYears: HORIZON, base: '3-yr avg FCF' },
        };
      }
    }
  }

  // Low earnings quality: a "cheap" multiple computed off non-operating
  // earnings is not a buy signal — downgrade cheap→fair on the P/E-derived
  // lenses (expensive readings are allowed to stand: bad earnings making a
  // stock LOOK expensive is information, not noise).
  if (lowEarningsQuality) {
    // DCF included: one-off income flows through CFO into FCF, inflating the
    // base and the delivered-growth comparison just like it inflates EPS.
    for (const lens of [peers, history, growth, dcf]) {
      if (lens.status === 'ok' && lens.signal === 'cheap') {
        lens.signal = 'fair';
        lens.qualityAdjusted = true;
      }
    }
    // Wording reflects what actually happened: claiming a downgrade on a
    // stock already grading expensive (nothing to downgrade) confused users.
    const downgraded = [peers, history, growth, dcf].some(l => l.qualityAdjusted);
    caveats.push(downgraded
      ? `Other income is ${oiSharePct}% of pre-tax profit (latest FY) — earnings are largely non-operating, so earnings-based "cheap" signals were downgraded to FAIR.`
      : `Other income is ${oiSharePct}% of pre-tax profit (latest FY) — earnings are largely non-operating; read P/E-based multiples with caution.`);
  }

  // Cyclical value-trap guard: a trailing-P/E "cheap" that the through-cycle
  // multiple contradicts (cycle-adjusted ≥ 1.5× trailing) is peak-earnings
  // optics, not cheapness.
  if (isCyclical && cycleAdjustedPE != null && currentPE != null && cycleAdjustedPE > currentPE * 1.5) {
    let downgraded = false;
    for (const lens of [peers, history]) {
      if (lens.status === 'ok' && lens.signal === 'cheap') {
        lens.signal = 'fair';
        lens.cycleAdjusted = true;
        downgraded = true;
      }
    }
    caveats.push(downgraded
      ? `Cycle-adjusted P/E (${cycleAdjustedPE.toFixed(1)}×) is well above trailing P/E (${currentPE.toFixed(1)}×) — earnings look cyclically elevated; "cheap" readings were downgraded.`
      : `Cycle-adjusted P/E (${cycleAdjustedPE.toFixed(1)}×) is well above trailing P/E (${currentPE.toFixed(1)}×) — earnings look cyclically elevated; trailing multiples flatter the stock.`);
  }

  // ── Composite verdict ───────────────────────────────────────────
  const lenses = { peers, history, growth, intrinsic, dcf };
  const weights = { peers: 1.0, history: 1.0, growth: 0.75, intrinsic: 0.75, dcf: 0.75 };
  const score = { cheap: 1, fair: 0, expensive: -1 };
  let total = 0, weightSum = 0, okCount = 0;
  const parts = [];
  for (const [name, lens] of Object.entries(lenses)) {
    if (lens.status !== 'ok') continue;
    okCount++;
    total += score[lens.signal] * weights[name];
    weightSum += weights[name];
    parts.push({ lens: name, signal: lens.signal });
  }

  let label = 'INSUFFICIENT DATA';
  if (okCount >= 2) {
    const avg = total / weightSum;
    const signals = parts.map(p => p.signal);
    const hasCheap = signals.includes('cheap');
    const hasExpensive = signals.includes('expensive');
    if (hasCheap && hasExpensive) label = 'MIXED';
    else if (avg >= 0.4) label = 'ATTRACTIVE';
    else if (avg <= -0.4) label = 'EXPENSIVE';
    else label = 'FAIR';
  } else if (lossMaking) {
    label = 'NOT MEANINGFUL';
  }

  const word = (s) => s === 'cheap' ? 'CHEAP' : s === 'expensive' ? 'EXPENSIVE' : 'FAIR';
  const headlineBits = [];
  if (peers.status === 'ok') headlineBits.push(`${word(peers.signal)} vs peers`);
  if (history.status === 'ok') headlineBits.push(`${word(history.signal)} vs own history`);
  if (headlineBits.length === 0 && growth.status === 'ok') headlineBits.push(`${word(growth.signal)} on growth-adjusted basis`);

  // Confidence: peers/history/growth all derive from the same EPS — they are
  // ONE correlated signal, not three. High confidence requires the (more)
  // independent intrinsic lens to agree with the overall direction.
  let confidence = 'low';
  if (okCount >= 3 && label !== 'MIXED' && label !== 'INSUFFICIENT DATA' && label !== 'NOT MEANINGFUL') {
    const dir = label === 'ATTRACTIVE' ? 'cheap' : label === 'EXPENSIVE' ? 'expensive' : 'fair';
    // High confidence needs corroboration from a lens NOT derived from the
    // same EPS input — intrinsic (book/residual income) or reverse DCF (FCF).
    const corroborated = (intrinsic.status === 'ok' && intrinsic.signal === dir)
      || (dcf.status === 'ok' && dcf.signal === dir);
    confidence = corroborated ? 'high' : 'moderate';
  } else if (okCount >= 2 && label !== 'MIXED') {
    confidence = 'moderate';
  }

  return {
    symbol,
    price: r2(price),
    verdict: {
      label,
      headline: headlineBits.join(' · ') || null,
      lensesUsed: okCount,
      totalLenses: Object.keys(lenses).length,
      confidence,
      note: 'Peers, history and growth lenses share the same EPS input — treat agreement among them as one signal, corroborated (or not) by the independent intrinsic and reverse-DCF lenses.',
      parts,
    },
    lenses,
    caveats,
    flags: { lossMaking, isFinancial, shareBaseShift: shiftDetected, lowEarningsQuality },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { computeValuation };
