# Volatility Contraction Pattern (VCP) — Design

**Date:** 2026-07-11
**Scope:** Add a deterministic VCP detector to the India Screener page and the
Instrument page. US pages (`UsScreener`, US instrument) are out of scope.

## Goal

Surface Minervini-style Volatility Contraction Pattern setups:
- **Screener:** a screenable 0–100 compression score + a YES/NO setup flag, so
  users can filter `vcpScore ≥ 70` or `vcpSetup is YES`.
- **Instrument:** the same score plus the full contraction anatomy (successive
  pullbacks T1/T2/T3… with depths and volume) for a single stock.

Fully deterministic — transparent formula over the OHLC series. No LLM in the
computation (narration only, optional, later).

## Approach

Hybrid (approach C):
- **Compression score (robust)** runs everywhere — cheap, no fragile pivot
  detection, safe across the whole scan universe.
- **Contraction-sequence anatomy (detailed)** runs only on the Instrument page,
  where one stock's swing pivots can be analyzed carefully and shown.

## Section 1 — Compression score (shared, deterministic)

Computed from the daily OHLC series already available in
`backend/screener/engine.js` via `buildSeries(candles)` (exposes `atr14`,
`ema200`, SMA helpers, `vol20avg`, `highs`, `lows`, `closes`, `volumes`).

### Precondition gate (Minervini trend template)

Not a VCP unless ALL hold at the last bar:
- `close > SMA50`
- `close > SMA200`
- `SMA200` rising: `SMA200(today) > SMA200(20 bars ago)`

Gate fail → `vcpSetup = 'NO'` and `vcpScore` forced low (multiply final score by
0.25 so a failed-gate stock can never rank as a setup). VCP is an uptrend
pattern; the gate is a hard precondition.

### Score components

Each normalized to 0–1, then weighted. Weights sum to 100.

| # | Component | Measure | 0 (min) | 1 (full) | Weight |
|---|-----------|---------|---------|----------|--------|
| 1 | Volatility contraction | `atrPctNow / atrPctPrior` where `atrPctNow = ATR14(last)/price`, `atrPctPrior = ATR14(last-50)/close(last-50)` | ratio ≥ 1.0 | ratio ≤ 0.5 | 35 |
| 2 | Coiling near pivot | distance below 50d high = `(price - hi50)/hi50` (≤ 0, i.e. below high) | ≤ −12% | ≥ −3% | 25 |
| 3 | Volume dry-up | `avgVol(last 10) / avgVol(prior 50)` | ≥ 1.0 | ≤ 0.6 | 25 |
| 4 | Base sanity | base depth = `(hiBase - loBase)/hiBase` over last 50 bars | outside 8–35% band | inside 8–35% band | 15 |

Normalization: linear clamp between the 0 and 1 anchors above; values beyond an
anchor clamp to 0 or 1. Component 4 is a band (full marks inside 8–35%, ramping
to 0 at 4% and at 50%).

`vcpScoreRaw` = Σ(component × weight) → 0–100.
`vcpScore` = `round(vcpScoreRaw × gateFactor)` where `gateFactor = 1` if gate
passes else `0.25`.
`vcpSetup` = `'YES'` when gate passes AND `vcpScore ≥ 70`, else `'NO'`.
Threshold 70 is a module-level constant (`VCP_SETUP_THRESHOLD`) for easy tuning.

Return `null` for `vcpScore` when the series is too short (`< 60` bars) — cannot
compute the prior-50 window. `vcpSetup` is then `'NO'`.

### New module

`backend/screener/vcp.js` — accepts **raw arrays** so it is decoupled from the
two different series builders in the codebase (`buildSeries` in the screener
engine, and the inline arrays in `computeStockAlert`):
- `computeVcpScore({ closes, highs, lows, volumes, atr14 }) → { vcpScore, vcpSetup, gatePassed, gateFailReason, components }`
  where `components` is `{ contraction, coiling, volumeDryUp, baseSanity }` (each
  0–1) plus the raw inputs (atr ratio, dist-from-high %, vol ratio, base depth %)
  for transparency and the Instrument panel.
- `computeVcpContractions({ highs, lows, volumes }) → { contractions, tightening, verdict }`.
- Pure functions. No I/O.
- `atr14` may be passed in (both callers already have it) or computed inside from
  highs/lows/closes via the `technicalindicators` `ATR` if absent.

SMA200-rising check: compute `SMA200(last)` and `SMA200(last-20)` inside
`vcp.js` from `closes` via a local rolling-mean helper — avoids depending on
either caller's SMA plumbing.

## Section 2 — Screener integration

`backend/screener/engine.js`:
- Add to `SCREENER_FIELDS`:
  - `{ key: 'vcpScore', label: 'VCP score (0-100)', type: 'number', group: 'Patterns' }`
  - `{ key: 'vcpSetup', label: 'VCP setup', type: 'enum', enumValues: ['YES','NO'], group: 'Patterns' }`
- In `computeScreenerRow`, after `S` is built, call `computeVcpScore(S, candles)`
  and spread `vcpScore` + `vcpSetup` into the returned values object.

`frontend/src/pages/Screener.jsx`:
- Add to `RESULT_COLUMNS`: `{ key: 'vcpScore', label: 'VCP' }`.
- Render the VCP cell with a highlight (accent border/background) when the row's
  `vcpSetup === 'YES'`, mirroring the existing enum-cell styling.
- Filtering works automatically via the field catalog (no extra UI).

## Section 3 — Instrument page integration

`frontend/src/pages/Instrument.jsx` gets a "Volatility Contraction (VCP)" panel:
- **Header:** score (0–100) + gate status ("trend template: pass/fail" with the
  failing condition named when it fails).
- **Component breakdown:** the four components as labeled bars/values so the
  score is fully transparent.
- **Contraction anatomy** (approach A, single stock): swing-pivot detection over
  the base to extract successive pullbacks.

### Contraction anatomy algorithm

Backend, exposed via the instrument data path (see below):
- Take daily closes/highs/lows over the last ~50–65 bars (the base).
- Detect swing pivots with a ZigZag over highs/lows: a swing forms when price
  reverses by ≥ a threshold (e.g. 3× a small % or ATR-based) from the last
  pivot. Deterministic, no library needed — simple state machine.
- From the pivot sequence, derive each pullback (contraction) as
  `(swingHigh - subsequentSwingLow)/swingHigh` → depth %.
- Report the ordered list of contraction depths + the average volume during each
  contraction leg (from `volumes`).
- Flag `tightening = true` when depths are (weakly) monotonically decreasing.
- One-line verdict string, e.g. `"3 contractions 18%→9%→5%, volume drying — coiled"`
  or `"no valid VCP: price below 200SMA"`.

### Where the anatomy is computed/served

The Instrument page reads `/api/instrument-alert/:token`, which returns the
`alert` object built by the shared pure function
`computeStockAlert({ symbol, token, candles, ... })` in `backend/server.js`
(also used by `/api/alerts`). This function already has the full candle series
and computes ATR/BB/SuperTrend.

Attach VCP there: inside `computeStockAlert`, call `computeVcpScore(...)` and
`computeVcpContractions(...)` from `backend/screener/vcp.js`, and add a `vcp`
block to the returned `alert`:
```
vcp: {
  score, setup, gatePassed, gateFailReason,   // score/gate
  components: { contraction, coiling, volumeDryUp, baseSanity, ...rawInputs },
  contractions: [{ depthPct, avgVolume }, ...],
  tightening, verdict                          // anatomy
}
```
Both pages share the one `vcp.js` module. `computeStockAlert` builds its own
series arrays (`closes`/`highs`/`lows`) already; pass what `vcp.js` needs (an
`S`-shaped object or the raw arrays) — the module accepts raw arrays to stay
decoupled from the two different series builders in the codebase.

## Data / feasibility

- Screener scan already builds `S` per symbol from full OHLC — VCP adds only
  arithmetic over series already in memory. Negligible cost.
- Instrument page already has the candles server-side. No new fetch.

## Error handling

- Series `< 60` bars → `vcpScore = null`, `vcpSetup = 'NO'`, anatomy verdict
  `"insufficient history"`.
- Missing SMA200 (young listing) → gate fails (treated as not-uptrend).
- All division guards mirror existing engine style (`> 0` checks).

## Testing

The backend has no test runner (`"test": "echo ... exit 1"`). Use Node's
built-in runner — no new dependency: set `backend/package.json` `"test": "node --test"`
and put tests in `backend/screener/vcp.test.js` using `node:test` + `node:assert`.

- Unit tests for `backend/screener/vcp.js` with synthetic candle series:
  1. Clean textbook VCP (declining ATR, tightening range, drying volume, above
     rising 200SMA) → high score, `vcpSetup = 'YES'`, 3 decreasing contractions.
  2. Downtrend / below 200SMA → gate fails, score low, `vcpSetup = 'NO'`.
  3. Expanding volatility (widening range) → low contraction component.
  4. Short series (< 60 bars) → `vcpScore = null`.
  5. Contraction detector: hand-built pivot series → expected depth list +
     `tightening` flag.
- Keep to the repo's existing test runner/pattern (check what the screener
  engine currently uses; add alongside).

## Out of scope (YAGNI)

- US screener/instrument.
- Breakout/entry-trigger alerts on VCP completion.
- LLM narration (can layer on later using the deterministic fields).
- Historical VCP backtest.

## Files touched

- `backend/screener/vcp.js` (new) — score + contraction detector, pure functions.
- `backend/screener/engine.js` — two fields + call in `computeScreenerRow`.
- `backend/server.js` — attach VCP score + anatomy to the instrument technicals
  response.
- `frontend/src/pages/Screener.jsx` — VCP result column + setup highlight.
- `frontend/src/pages/Instrument.jsx` — VCP panel (score, components, anatomy).
- Tests for `vcp.js`.
