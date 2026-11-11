// ─── The measured US answer to "does heavy volume mean anything?" ───────────
//
// Headline numbers from backend/volumeThrustStudy.js, run 2026-11-04 over 502
// S&P 500 names, 2014-01-02 → 2026-11-04, excess over the S&P 500. The full
// grid and caveats are in backend/reports/volume-thrust-us/2026-11-04.txt.
// Re-run with `node volumeThrustStudy.js` from backend/ and update both.
//
// Why a module and not the registry: signals/registry.js is hashed into
// PRICE_RULE_VERSION, so recording a result in its description text — the
// dead_cat_bounce precedent — would mint a new price-rule version and restart
// the recorded track record of every price signal. A dated constant beside the
// display costs nothing to the evidence it describes.
//
// The study had existed since August; nobody had run it, so the volume pane
// highlighted heavy bars with no answer to whether they were worth acting on.
// The answer is no, at every threshold tried.

export const US_VOLUME_STUDY = {
  runOn: '2026-11-04',
  from: '2014-01-02',
  to: '2026-11-04',
  symbols: 502,
  benchmark: 'S&P 500',
  report: 'backend/reports/volume-thrust-us/2026-11-04.txt',
  // The registered rule: 2× the trailing 20-day average on an up close, first of a run.
  thrust: { firings: 25363, n10d: 25209, median10dExcessPct: -0.18, t: -0.18 },
  // The same question at every multiple in the grid — none clears noise.
  thresholds: [
    { mult: 1.5, median10dExcessPct: -0.10, t: 0.79 },
    { mult: 2, median10dExcessPct: -0.18, t: -0.18 },
    { mult: 2.5, median10dExcessPct: -0.18, t: -0.24 },
    { mult: 3, median10dExcessPct: -0.23, t: -0.11 },
  ],
  // Volume as a FILTER on the golden-cross buy (confirmed minus unconfirmed),
  // shipped setting: no measurable difference at any horizon.
  confirmationLift: { horizon: '10d', pp: 0.12, t: 0.95 },
  caveats: 'Survivorship bias (today\'s index members), firings cluster in market-wide volume weeks so n overstates independent evidence, entry at the firing close with no costs. A US result is evidence about the rule, not about Indian stocks.',
}
