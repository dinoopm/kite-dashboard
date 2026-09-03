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
| `momentumRaw` | `close[t−5] / close[t−25] − 1` | 20 sessions skipping the latest 5. Identical to India's `ret_20_5`. |
| `volumeRaw` | `max(0, surge) × authenticity` | `surge = mean(vol[t−4..t]) / mean(vol[t−19..t−5]) − 1`. `authenticity = 0.6·corroboration + 0.4·persistence`. `corroboration = clamp01(|ret5%| / (0.5 + surge%/200))` (India's formula). `persistence` = fraction of the last 5 sessions with volume > 1.5× the baseline. No delivery term — the data does not exist. |
| `fiftyTwoRaw` | `(newHigh5 ? 1 : 0) − (newLow5 ? 1 : 0) + (close / high252 − 0.8)` | `high252`/`low252` = max/min close over the prior 252 sessions. `newHigh5` = any of the last 5 closes was the rolling 252-session high at that bar. Adjusted closes, so splits do not fake highs. |
| `relStrengthRaw` | `(close/close[t−63] − 1) − (SPY/SPY[t−63] − 1)`, in percentage points | Deliberately a longer horizon than momentum. |
| `revisionsRaw` | `0.5·(up − down)/(up + down) + 0.5·clamp(trendNow/trend30dAgo − 1, −0.2, 0.2)/0.2` from Yahoo `earningsTrend`, current fiscal year | `null` when unavailable → neutral mid-rank, matching India's treatment of a missing history. |

`trapRisk` = `surge > 1.0 && authenticity < 0.45`, with a stated `trapReason`.
Trap names are excluded from the recorded snapshot and hidden in the UI by
default; a toggle shows them, as on the Indian page.

Default weights: momentum 30, volume 20, fiftyTwo 15, relStrength 20, revisions 15.

## Exclusions

Removed before ranking. The response carries `excludedCount` and a sample with
reasons, like India's surveillance exclusion.

- **Illiquid** — median 20-session dollar volume below $10M.
- **Earnings within the next 5 sessions** — from the existing earnings-calendar
  cache in `alpaca.js`. A binary event, not a factor bet.
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

`dailyJobs.js` gains a US step that runs on ticks after 21:30 IST (US close plus
settlement). Completion is decided by asking `us_pick_snapshots` whether a row for
the latest SPY bar date exists — the same DB-decided pattern the Indian snapshot
uses, so a restart neither repeats nor skips the day. Revisions are refreshed in
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
