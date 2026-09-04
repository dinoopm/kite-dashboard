# US Quant Stock Picks — design

**Date:** 2026-09-03
**Status:** approved in conversation, pending written review

## Purpose

A deterministic, transparent factor ranking over US large caps, built the way the
Indian Quant Picks page is built — raw factors server-side, percentile ranking and
weights client-side, a default-weight top-25 snapshot recorded daily, and a
scorecard that says what those recorded picks went on to do. The LLM only narrates
the ranked output; it never chooses or reorders.

Two things differ from India by necessity and one by opportunity:

- Two Indian guards have no US equivalent (delivery %, bulk-deal disclosure), so
  the institutional-deals factor is replaced by relative strength vs SPY and by EPS
  estimate revisions.
- India's regime line reads FII/DII flows; the US line reads market breadth plus the
  existing macro regime.
- The US has ten years of clean daily history, so the price factors are backtested
  **before** the first snapshot is written. India could only be scored after the
  fact.

Per `CLAUDE.md`, the engine ships with its snapshot table, scorecard wiring and
`<SignalScore>` badge in the same change. It is not a standalone ranking.

## Not in scope

Sector-neutral ranking, position sizing, alerts, and any change to the Indian
engine's ranking code. The Indian page's behaviour must be unchanged after this
work; the only touch is importing a shared percentile helper.

## Architecture

```
backend/usPicks/
  engine.js        buildUsFactorUniverse({ asOf }) → { period, regime, excluded, stocks[] }
                   rankUniverse(stocks, weights, { excludeTraps })
                   saveDailySnapshot(universe), fetchSnapshotHistory(since)
                   generateUsPicksSummary(...)           (Groq narration only)
  factors.js       pure per-symbol factor maths from bars  (tested in isolation)
  revisions.js     Yahoo earningsTrend fetch + 24h cache → revisionsRaw per symbol
  backtest.js      runUsBacktest() — weekly re-evaluation 2015→today, price factors only
  scorecard.js     runUsPicksScorecard() — recorded rows scored vs SPY
backend/signals/usMarketSeries.js
                   SPY calendar + per-symbol closes from fetchBarsMulti; benchmark SPY
backend/migrate_us_pick_snapshots.js
                   prints DDL, verifies reachability (manual-DDL pattern)
backend/alpaca.js  routes under /api/us/stock-picks/* (thin; logic in usPicks/)
backend/dailyJobs.js
                   US snapshot step, DB-decided completion
backend/signals/registry.js
                   us_picks_top25, us_picks_top10 (source 'recorded', market 'US')

frontend/src/lib/picksRank.js         percentileRanks, normaliseWeights (shared by both pages)
frontend/src/pages/us/UsStockPicks.jsx
frontend/src/components/SignalScore.jsx + lib/useSignalScore.js
                   market="US" resolves against the US scorecard endpoint
frontend/src/components/Navbar.jsx    "Quant Picks" under the US dropdown
```

Bars come from `fetchBarsMulti` in `backend/alpaca.js` (Alpaca multi-symbol
endpoint, `adjustment: 'all'`, 100 symbols per call, 1h cache). The engine never
fetches per symbol.

## Universe

`getSP500() ∪ getNasdaq100()`, deduplicated on symbol (~560 names). Sector comes
from the S&P scrape's GICS field; Nasdaq-100-only names use `fetchAssetSector`
(Yahoo, 7-day cache). Live runs fetch 15 months of bars — 252 sessions for the
52-week window, 63 for relative strength, margin for holidays.

## Factors

All raw values are per stock, as of the evaluation date, from bars at or before
that date. Percentile ranking happens later.

| factor | raw value | notes |
|---|---|---|
| `momentumRaw` | `close[t−21] / close[t−273] − 1` | 252 sessions skipping the latest 21 — twelve months, skipping the most recent one. Chosen by the sweep in `deadCatStudy`-style fashion: of `{20/5, 60/5, 120/20, 252/21}` it was the strongest (+0.51% 10d excess vs SPY, t=3.86) and the ONLY setting with a positive composite IC. It is also the momentum definition the academic literature settled on. India's 20/5 was kept for parity in the first draft and abandoned here because parity with an unvalidated setting is not a reason. |
| `volumeRaw` | `max(0, surge) × authenticity` | `surge = mean(vol[t−4..t]) / mean(vol[t−19..t−5]) − 1`. `authenticity = 0.6·corroboration + 0.4·persistence`. `corroboration = clamp01(|ret5%| / (0.5 + surge%/200))` (India's formula). `persistence` = fraction of the last 5 sessions with volume > 1.5× the baseline. No delivery term — the data does not exist. |
| `fiftyTwoRaw` | `(newHigh5 ? 1 : 0) − (newLow5 ? 1 : 0) + (close / high252 − 0.8)` | `high252`/`low252` = max/min close over the prior 252 sessions. `newHigh5` = any of the last 5 closes was the rolling 252-session high at that bar. Adjusted closes, so splits do not fake highs. |
| `relStrengthRaw` | `(close/close[t−63] − 1) − (SPY/SPY[t−63] − 1)`, in percentage points | Deliberately a longer horizon than momentum. |
| `revisionsRaw` | `0.5·(up − down)/(up + down) + 0.5·clamp(trendNow/trend30dAgo − 1, −0.2, 0.2)/0.2` from Yahoo `earningsTrend`, current fiscal year | `null` when unavailable → neutral mid-rank, matching India's treatment of a missing history. When only ONE of the two components exists, that component is returned unweighted, not halved: the blend is a weighted average of what is available, so a stock carrying a single signal stays on the same ±1 scale as one carrying both. Halving it would shrink every single-signal stock toward neutral, and since the output is percentile-ranked, that would bury them mid-pack however strong the signal. |

`trapRisk` = `surge > 1.0 && authenticity < 0.45`, with a stated `trapReason`.
Trap names are excluded from the recorded snapshot and hidden in the UI by
default; a toggle shows them, as on the Indian page.

Default weights: momentum 30, volume 20, fiftyTwo 15, relStrength 20, revisions 15.

## What the backtest found, before anything shipped

Two runs matter. The first used momentum 20/5 and is what prompted the switch to
252/21; the second is the model that actually ships. Both are recorded because
the difference between them is itself the finding.

**Shipped model — momentum 252/21**, 481 evaluation dates (2017-01-13 →
2026-08-04, 518 names), four price factors, revisions at weight 0:

| horizon | top-25 vs SPY | t | hit rate | Q1 → Q5 (top → bottom) |
|---|---|---|---|---|
| 5d | +0.26% | 2.72 | 52.2% | 0.42 / 0.35 / 0.32 / 0.31 / 0.42 |
| 10d | +0.52% | 3.89 | 52.3% | 0.83 / 0.69 / 0.63 / 0.62 / 0.79 |
| 22d | +0.97% | 4.57 | 51.2% | 1.65 / 1.45 / 1.34 / 1.34 / 1.67 |

Information coefficients at 10d: momentum +0.016 (t=1.55), volume +0.002,
52-week −0.007, relative strength −0.010, **composite +0.005 (t=0.46)**.

**The honest read: no measurable ranking skill.** The composite's IC is +0.005
with t=0.46 — indistinguishable from zero over 478 dates. Momentum is the only
factor pulling in the right direction and it does not reach significance either.
A hit rate of 51–52% is a coin flip with a thumb on it.

**The quintiles are U-shaped, not monotonic.** At every horizon the MIDDLE
quintiles are the trough and both ends are raised: at 22d the run is 1.65 / 1.45
/ 1.34 / 1.34 / 1.67, with the bottom fifth still edging the top. A model that
ranked would descend from Q1 to Q5. A U says the composite is selecting for
something both tails share — most plausibly volatility — rather than ordering
stocks by future return.

That is also the most likely source of the top-25 excess. The top 25 is the
extreme tail of ~500 names, and the extreme tail of a volatility-loaded score is
a basket of high-beta stocks, measured across a decade-long bull market. The
t-statistics are real; the interpretation "this ranks stocks" is not supported.

**Why the earlier 20/5 run is kept.** At momentum 20/5 the same code produced a
composite IC of −0.009 (t=−1.05) and quintiles that were outright INVERTED — the
bottom fifth beat the top at all three horizons. Switching to 252/21 moved the
composite IC positive, lifted the hit rate about a point, and pulled Q1 back
above Q5 at 10 days. The direction of that change is evidence the momentum
window was doing real damage at 20/5; the fact that it still does not reach
significance is evidence the model does not rank.

A methodological caveat found in the same pass: `excessVsMedian` compares the
MEAN return of the top 25 against the MEDIAN return of the universe. Equity
returns are right-skewed, so the universe mean sits above its median and the
comparison flatters the picks by construction. The vs-SPY column is a fair
portfolio comparison and is the one to read; the vs-median column is inflated by
an unknown amount. (`picks/backtest.js` shares this flaw — it is where the
pattern was copied from.)

**The page must therefore lead with this, not bury it.** The backtest panel
states that no ranking skill was measurable and that the excess is likely beta,
before any t-statistic. The recorded scorecard remains the honest forward test
and starts empty. Shipping a screen whose own evidence says it does not rank is
only defensible while that sentence is the first thing a reader sees.

## Exclusions

Removed before ranking. The response carries `excludedCount` and a sample with
reasons, like India's surveillance exclusion.

- **Illiquid** — median 20-session dollar volume below $10M.
- **Earnings within the next 5 sessions** — from the existing earnings-calendar
  cache in `alpaca.js`. A binary event, not a factor bet. The window is counted
  in weekdays between the snapshot date and the earnings date, NOT along the
  SPY bar calendar: earnings dates are in the future and the bar calendar stops
  at the last close, so counting sessions on it would compare against dates
  that do not exist yet. Weekdays ignore market holidays, which can make the
  window one session generous around a holiday — the error is in the safe
  direction (excluding a stock a day early).
- **Red-severity red flag** — the `pump-fade` check from the US red-flags logic,
  called as a function on the already-fetched bars, never via HTTP. Amber flags
  (thin liquidity, fading volume, gap-and-fade) are shown as chips and do not
  exclude.

## Regime

Computed from the same bars, no extra fetches:

- Breadth: % of universe above its 50-day SMA, % above its 200-day SMA, % with
  positive `momentumRaw`.
- Label: both SMA readings > 60% → `risk-on`; both < 40% → `risk-off`; otherwise
  `mixed`.
- The latest `macro_signal_snapshots` label (cooling / neutral / re-accelerating)
  is appended verbatim.

Rendered as one line, e.g. *Breadth risk-on (68% > 50D, 74% > 200D) · macro
re-accelerating*.

## Ranking and snapshot

Client-side ranking uses mid-rank percentiles × normalised weights, the maths
India's page has inline. That code moves to `frontend/src/lib/picksRank.js`; a
parity test asserts identical output, then the Indian page imports it. Server-side
`rankUniverse` uses the same percentile function (ported, tested for parity) with
`DEFAULT_WEIGHTS` and traps excluded, and is the only thing that writes snapshots.

Table `us_pick_snapshots` (manual DDL via `migrate_us_pick_snapshots.js`):

```
snap_date          date     not null
symbol             text     not null
rank               int      not null
composite          numeric
momentum_pct       numeric
volume_pct         numeric
fifty_two_pct      numeric
rel_strength_pct   numeric
revisions_pct      numeric
revisions_raw      numeric
trap_risk          boolean  default false
last_close         numeric
created_at         timestamptz default now()
primary key (snap_date, symbol)
index (symbol, snap_date desc)
```

Per-factor percentiles are stored so each factor's forward information coefficient
can later be measured from recorded rows. That is how EPS revisions — which cannot
be backtested — earns or loses its weight honestly.

`snap_date` is the last SPY bar date, never the wall clock.

## Daily job

`dailyJobs.js` gains a US step. It is due when the latest SPY daily bar from
Alpaca is newer than the latest `us_pick_snapshots.snap_date` **and** that
session has closed — the bar's date is before today (UTC) or it is at or past
21:00 UTC (16:00 ET plus settlement, either DST regime). Completion is decided by
the table, not a flag — the same DB-decided pattern the Indian snapshot uses, so
a restart neither repeats nor skips the day. Revisions are refreshed in
the same step (Yahoo, chunked, 24h cache) before ranking.

## Scoring

- `usPicks/scorecard.js` → `GET /api/us/stock-picks/scorecard`. Reads recorded
  rows, scores top-25 and top-10 at 5/10/22-bar horizons, excess over **SPY**,
  median alongside mean, unresolved counted not scored. Below 20 resolved
  snapshot days the headline says "too few to judge".
- `signals/usMarketSeries.js` supplies the SPY calendar, per-symbol closes and the
  benchmark, built on `fetchBarsMulti`. A sibling of `marketSeries.js`, not a flag
  threaded through it. `calendarGaps` is reported for symmetry even though Alpaca
  bars have not shown holes.
- Registry entries `us_picks_top25` and `us_picks_top10` carry `source:
  'recorded'` and `market: 'US'`. `signals/scorecard.js` skips `market: 'US'`
  entries with a pointer to the US endpoint, so they are never scored against
  NIFTY by accident.
- `SignalScore` / `useSignalScore` accept `market`; for `'US'` the hook fetches the
  US scorecard. US charts that show signals not present there keep rendering "not
  measured here".

## Backtest

`usPicks/backtest.js` → `GET /api/us/stock-picks/backtest`, cached 6h,
`?force=1` recomputes.

- Bars from 2015-01-01 for the whole universe, one `fetchBarsMulti` pass.
- Evaluation every 5th session (~500 dates). The engine's factor functions are
  imported and run on bars ≤ the evaluation date. Nothing looks ahead.
- Composite under test is the four price factors with revisions weight 0. The
  output header states that the live composite differs.
- Per horizon 5/10/22: top-25 and top-10 median excess vs the universe median
  **and** vs SPY; hit rate; quintile monotonicity of composite vs forward return;
  per-factor Spearman IC with t-stat.
- Momentum-window sweep `{20/5, 60/5, 120/20, 252/21}` reported alongside the
  shipped 20/5.
- Caveats in the output: survivorship (today's members — delisted losers absent,
  which flatters), clustered dates, no costs or slippage, earnings and red-flag
  exclusions applied with today's calendar so the backtest universe is slightly
  wider than live.

Where backtest and scorecard disagree, the scorecard is the honest number — in
`CLAUDE.md` and repeated in the UI panel.

## UI

`frontend/src/pages/us/UsStockPicks.jsx`, route `/us/stock-picks`, nav label
"Quant Picks" in the US dropdown. A separate page, by decision; shared maths lives
in `lib/picksRank.js`.

- Header: regime line, universe size, exclusion count with sample, snapshot date.
- Controls: five weight sliders, presets (Momentum-heavy / Balanced /
  Revisions-on), trap toggle, an "N names hidden — reporting within 5 sessions"
  count.
- Table: rank, symbol, name, sector, price, composite, five factor bars, chips for
  trap, amber flags, imminent earnings, market-cap tag ($B). Row click →
  `/us/:symbol`.
- Track-record strip beside the table header: `<SignalScore signal="us_picks_top25"
  market="US"/>` and top-10.
- Backtest panel, collapsed by default, with the scorecard-wins sentence.
- History/diff panel (new, dropped, streak) from `/api/us/stock-picks/history`.
- AI brief via `POST /api/us/stock-picks/summary`: Groq narrates the ranked rows
  under India's rules (no invented tickers, no reordering, no advice), with US
  terms — breadth/macro regime, trap, amber flags, imminent earnings, missing
  revisions. Ends with the same disclaimer line.

Formatting: `$`, `en-US` locale.

## Error handling

- Revisions fetch failure for a symbol → `revisionsRaw = null`, ranked neutral,
  counted in the response as `revisionsMissing`.
- Missing `us_pick_snapshots` table → history/scorecard respond `available: false`
  with the migration hint, as India does.
- Alpaca not configured → the route returns the existing 503 shape.
- The daily step logs and retries next tick on any failure; no flag is set before
  the write succeeds.

## Tests (node:test)

- `usPicks/factors.test.js` — every factor on synthetic bars: skip window,
  surge vs baseline, authenticity without a delivery term, 52-week from adjusted
  closes, relative-strength sign, `null` revisions → neutral, trap threshold,
  each exclusion.
- `usPicks/backtest.test.js` — quintile and IC helpers; causality (a firing is
  unchanged by bars after it).
- `usPicks/scorecard.test.js` — headline states, gap reporting on the US series.
- `lib/picksRank.test.js` — output identical to the Indian page's inline copy
  before that copy is removed.
- `signals/registry.test.js` — US entries carry `market: 'US'` and are skipped by
  the Indian scorecard.

## Data facts to respect

- Supabase DDL is manual; the migration script prints SQL and verifies.
- Yahoo `earningsTrend` is ~560 calls per day; chunked, cached 24h, run in the
  daily job rather than on page load.
- Bars are `adjustment: 'all'`; the screener and this engine must keep reading the
  same adjusted series or their momentum figures will disagree.
