# US Indices — Market Breadth + ADX

**Date:** 2026-07-14
**Status:** Approved

## Goal

Add market-regime context to the US indices page (`frontend/src/pages/us/UsIndices.jsx`):
1. S&P 500 constituent breadth (% of members above 50/200-day SMA) — true internals.
2. ETF-level breadth chips computed from rows already on the page.
3. ADX(14) column per ETF row in the indices table.

## 1. Backend — `GET /api/us/breadth`

New route in `backend/alpaca.js`.

- **Universe:** `getSP500()` (already exists in `usUniverses.js`).
- **Bars:** `fetchBarsMulti(symbols, start)` (already exists), `start = now − 310 calendar days` — guarantees ≥ 200 trading bars.
- **Per symbol:** skip if < 200 bars. Compare last close to SMA50 and SMA200 of closes.
- **Response:**
  ```json
  {
    "pctAbove50": 61.2,
    "pctAbove200": 74.8,
    "above50": 306,
    "above200": 374,
    "total": 500,
    "asOf": "2026-07-14",
    "cached": false
  }
  ```
  `total` = symbols with enough data (excludes skips). `asOf` = latest bar date seen.
- **Caching:** in-memory, 30-min TTL, in-flight coalescing (mirror `usUniverses.js` pattern). Cold call makes ~10–15 Alpaca requests (5 chunks × pagination); warm call is free.
- **Failure:** propagate 500. No stub data.

## 2. Frontend — breadth strip

Rendered in `UsIndices.jsx` above the table, hidden when `activeTab === 'global'`.

- **S&P 500 internals card** (from `/api/us/breadth`, fetched once on mount, refetch on 30-min interval):
  - Two stats: "% above 50DMA", "% above 200DMA". Big number styling consistent with page.
  - Color per stat: ≥ 70 % green (`#22c55e`), 40–70 % neutral/amber, < 40 % red (`#ef4444`).
  - Subtext: `306 of 500` style count and `as of <date>`.
  - Endpoint error/loading → card hidden (no skeleton, no error banner).
- **ETF breadth chips** (pure client compute from loaded sector-tab rows, zero fetches):
  - "Above 50DMA: N/M sectors" — from `row.aboveSma50` (already computed per row).
  - "Advancing today: N/M" — from `row['1D'] > 0`.
  - M = sector-category ETFs with non-null data; chips hidden until history loads.

## 3. Frontend — ADX(14) column

- **Shared helper:** move `adx14` from `UsInstrument.jsx:90` to new `frontend/src/lib/indicators.js`; `UsInstrument.jsx` imports it (local copy deleted). `UsIndices.jsx` imports it too.
- **Compute:** in the existing row-enrichment `useMemo`, `adx14(row.history)` when history present; null otherwise.
- **Cell render:** value to 1 decimal +
  - ADX ≥ 25 and `aboveSma50` → green (trending up)
  - ADX ≥ 25 and not above SMA50 → red (trending down)
  - 20 ≤ ADX < 25 → default text color
  - ADX < 20 → grey (chop)
  - null → "–"
- **Sortable** like other numeric columns; included in CSV export.

## Testing

- One-off node script: hit `/api/us/breadth`, assert `0 < pctAbove50 < 100`, `0 < pctAbove200 < 100`, `total ≥ 450`, second call returns `cached: true` fast.
- Browser (preview server): indices page shows internals card, ETF chips, ADX column with plausible values; sort by ADX works; global tab hides strip.

## Out of scope

- Advance/decline counts of S&P constituents, new highs/lows, McClellan — user chose only %-above-MA internals.
- Historical breadth chart (time series) — future work if wanted.
