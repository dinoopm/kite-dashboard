// ─── India screener presets ──────────────────────────────────────────────────
//
// Data only, kept out of the page so a test can hold the rule every preset
// lives by: a preset is a buy cue, so it shows either the track record of the
// registered signal it reproduces (`signal`, rendered as a SignalScore badge)
// or a `note` saying plainly that what it screens for has not been measured.
// Never neither — that is how a filter looks authoritative without evidence.
// See lib/screenerPresets.test.js.

// Built-in preset screens. Scope is left alone — the India screener defaults to
// holdings, and a preset should change WHAT is asked, not WHERE.
export const RANGE_PRESET = {
  id: 'p-range-relative', name: 'Range breakout + relative strength',
  note: '30-session range; volume ≥1.5×; holds 3 sessions; stock/index ratio makes a 20-session high. Rule not separately validated.',
  conditions: [
    { field: 'rangeBreakoutStatus', op: 'is', value: 'CONFIRMED' },
    { field: 'rangeBreakoutAge', op: 'lte', value: 10 },
    { field: 'rangeBreakoutBasePct', op: 'lte', value: 25 },
    { field: 'rangeBreakoutVol', op: 'gte', value: 1.5 },
    { field: 'rangeBreakoutDistance', op: 'gte', value: 0 },
    { field: 'rangeBreakoutDistance', op: 'lte', value: 10 },
    { field: 'rangeBreakoutRs', op: 'is', value: 'YES' },
  ],
}
export const PRESET_SCREENS = [
  RANGE_PRESET,
  // Thresholds are measured, not chosen. backend/baseBreakoutStudy.js swept
  // them over 498 S&P 500 names, 2014-2026: the 22-day median excess over the
  // index runs +0.48% at range<=30 (t=4.1, n=2358), +0.15% at 45 (t=2.4),
  // +0.08% at 60 (t=1.2) and vanishes by 80. The decay is smooth as the base
  // widens, which is what a real effect looks like rather than a threshold
  // artifact — so the tight setting is the default. Nothing shows at 5 or 10
  // days; only 22.
  // Registered as base_breakout and blocked on Indian data: the base takes a
  // year to form, and nse_bhavcopy starts 2026-04-02. The badge says so, with
  // the US study above as context rather than as an Indian result.
  { id: 'p-basebreak', name: 'Year-long base → fresh BUY', signal: 'base_breakout', conditions: [
    { field: 'range52wPct', op: 'lte', value: 30 },
    { field: 'ret1Y', op: 'lte', value: 15 },
    { field: 'ret1Y', op: 'gte', value: -15 },
    { field: 'signal1050', op: 'is', value: 'BUY' },
    { field: 'signal1050Age', op: 'lte', value: 10 },
  ] },
  { id: 'p-buy20d', name: 'BUY + 20d breakout',
    note: 'A 10/50 buy and a 20-day breakout together — not measured as a pair. Each is scored on its own on the Track Record page.',
    conditions: [
    { field: 'signal1050', op: 'is', value: 'BUY' },
    { field: 'breakout20d', op: 'is', value: 'YES' },
  ] },
  // The Signals-tab setup, screened: the golden-cross buy with a volume thrust
  // behind it. `signal` names the registry entry these conditions reproduce, so
  // the card can carry that entry's track record — the same badge the chart
  // shows beside the marker, over the same rule.
  //
  // The pair is deliberate and they are DISJOINT halves of ma_cross_up, not a
  // good screen and a worse one. Volume confirmation is only worth applying as
  // a filter if the quiet half does measurably worse, and that comparison is
  // unreadable unless both are on screen. Loading the control is how you find
  // out whether the filter earns its place; if their badges agree, it does not.
  { id: 'p-cross-vol', name: 'Golden cross, volume-confirmed', signal: 'ma_cross_volume', conditions: [
    { field: 'signal1050', op: 'is', value: 'BUY' },
    { field: 'signal1050Age', op: 'lte', value: 10 },
    { field: 'crossVolConfirmed', op: 'is', value: 'YES' },
  ] },
  { id: 'p-cross-quiet', name: 'Golden cross, no volume (control)', signal: 'ma_cross_quiet', conditions: [
    { field: 'signal1050', op: 'is', value: 'BUY' },
    { field: 'signal1050Age', op: 'lte', value: 10 },
    { field: 'crossVolConfirmed', op: 'is', value: 'NO' },
  ] },
  // The chart setup read off the Signals tab: a fresh buy marker, a tinted
  // (>=2x) volume bar behind it, RSI above 60 at the cross.
  //
  // Deliberately carries NO track-record badge, unlike the two above. The
  // scored rule is ma_cross_volume, whose RSI gate is >50; asking for >60 is a
  // tighter cut of it that nothing has measured separately. Showing the parent's
  // record here would attach a number to a rule it was not measured on — the
  // same reason the Signals tab hides its badge when the period sliders move
  // off 10/50. The note renders in its place so the gap is visible rather than
  // merely absent.
  {
    id: 'p-cross-rsi60',
    name: '2× volume + buy + RSI 60',
    note: 'Tighter than the scored rule (ma_cross_volume gates RSI at 50). No separate record yet.',
    conditions: [
      { field: 'signal1050', op: 'is', value: 'BUY' },
      { field: 'signal1050Age', op: 'lte', value: 10 },
      { field: 'crossVolConfirmed', op: 'is', value: 'YES' },
      { field: 'crossRsi', op: 'gt', value: 60 },
    ],
  },
  { id: 'p-coiling', name: 'Coiling (3m tighter than 12m)',
    note: 'Range compression on its own. Not registered or measured; it describes a shape, not an outcome.',
    conditions: [
    { field: 'rangeCompression', op: 'lte', value: 0.5 },
    { field: 'range52wPct', op: 'lte', value: 60 },
  ] },
  { id: 'p-vcp', name: 'VCP setups', signal: 'vcp_setup', conditions: [
    { field: 'vcpSetup', op: 'is', value: 'YES' },
  ] },
  // Bollinger squeeze: bandwidth at (or within 5% of) its 30-day low. The
  // folklore is that compressed volatility precedes a breakout, and unlike the
  // base-breakout preset above, these thresholds have NOT yet been swept — the
  // 20/2/30/5% settings come from the chart, not from a measurement. Registered
  // as `bb_squeeze` so the scorecard starts building a track record from the
  // first firing rather than after a year of acting on it.
  //
  // Paired with a trend filter on purpose: a squeeze says a move is coming,
  // never which way, and screening for it alone returns as many breakdowns as
  // breakouts.
  { id: 'p-bbsqueeze', name: 'Bollinger squeeze (coiled)',
    note: 'Stricter than the scored rule (bb_squeeze fires on the first day of a squeeze; this asks for 3+ days and price above the 200-day average). No separate record.',
    conditions: [
    { field: 'bbSqueeze', op: 'is', value: 'YES' },
    { field: 'bbSqueezeAge', op: 'gte', value: 3 },
    { field: 'pctVsSma200', op: 'gt', value: 0 },
  ] },
]
