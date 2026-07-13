# Crude Oil Price Tracker — Design

**Date:** 2026-07-12
**Scope:** Dedicated Market Data page tracking WTI + Brent crude spot prices.

## Goal

Track both benchmark crudes — WTI (`CL=F`) and Brent (`BZ=F`) — on a dedicated
page under the Market Data dropdown. Spot price, day change, day range, 52-week
range. No historical chart, no Brent–WTI spread, no INR conversion (all
explicitly out of scope per user selection; easy later adds).

## Data source & freshness

Yahoo Finance via the existing `yahooFinance` instance (`backend/server.js:8`,
`new YahooFinance()`). Verified live: `yahooFinance.quote(['CL=F','BZ=F'])`
returns price, change, changePct, prevClose, day low/high, 52w low/high,
currency, `regularMarketTime`, `marketState`, and `exchangeDataDelayedBy`.

**Data is 10-minute delayed** (NYMEX free feed). The page must disclose this:
show "as of <time> · 10-min delayed" so freshness is honest. Futures trade
nearly 24h Sun–Fri, so quotes stay fresh around the clock.

## Backend — `GET /api/oil`

In `backend/server.js`:
- `yahooFinance.quote(['CL=F', 'BZ=F'], {}, { validateResult: false })`.
- Response:
```json
{
  "wti":   { "symbol": "CL=F", "name": "WTI Crude", "price": 73.71, "change": 2.30,
             "changePct": 3.22, "prevClose": 71.41, "dayLow": 72.61, "dayHigh": 75.08,
             "week52Low": 54.98, "week52High": 119.48, "currency": "USD",
             "quoteTime": "2026-07-13T13:31:47.000Z", "delayMin": 10, "marketState": "REGULAR" },
  "brent": { ...same shape... },
  "asOf": "<server time ISO>"
}
```
- Field mapping: `price = regularMarketPrice`, `change = regularMarketChange`,
  `changePct = regularMarketChangePercent`, `prevClose = regularMarketPreviousClose`,
  `dayLow/High = regularMarketDayLow/High`, `week52Low/High = fiftyTwoWeekLow/High`,
  `quoteTime = regularMarketTime`, `delayMin = exchangeDataDelayedBy ?? 10`.
  All `?? null`. Names hardcoded ("WTI Crude", "Brent Crude") — Yahoo's
  shortNames are contract-month noise ("Crude Oil Aug 26").
- Module cache `{ data, ts }`, TTL 2 minutes. Serve cached inside TTL.
- Yahoo failure → `res.status(502).json({ error: err.message })`; if a cached
  copy exists (even expired), serve it with `"stale": true` instead of erroring.

## Frontend — `frontend/src/pages/marketData/OilTracker.jsx` (new)

VIX-page idiom, but spot-only:
- Page header: "Crude Oil" + subtitle "WTI & Brent spot · Yahoo Finance ·
  10-min delayed" and an as-of time (from `quoteTime`, rendered in local time).
- Two `glass-panel` stat cards side by side (flex, wraps on narrow):
  - Grade name + symbol chip (`CL=F` / `BZ=F`).
  - Big price (`$73.71`) + colored day change: `+2.30 (+3.22%)`
    (`positive`/`negative` classes).
  - **Day range bar:** horizontal track from `dayLow` to `dayHigh` with a
    marker at `price`; low/high labeled at the ends.
  - **52-week range bar:** same treatment for `week52Low → week52High`.
  - Previous close line.
- Auto-refresh every 60s (interval + cleanup); manual "↻ Refresh" button.
  `marketState` shown as a small chip (REGULAR/CLOSED etc.).
- Loading: existing `.loader`. Error: message + retry button (Portfolio idiom).
  `stale: true` → small amber "stale data" note.
- All numeric fields nullable-safe (`—` fallback).

## Wiring

- `frontend/src/components/Navbar.jsx`: append to the Market Data sublinks:
  `{ to: '/market-data/oil', label: 'Crude Oil (WTI / Brent)', hint: 'WTI & Brent spot, day change and ranges (10-min delayed).' }`
- `frontend/src/App.jsx`: import + `<Route path="/market-data/oil" element={<OilTracker />} />`
  next to the other market-data routes.

## Error handling

- Yahoo down, no cache → page error state with retry.
- Yahoo down, expired cache → stale data + amber note.
- Partial result (one symbol missing) → render the available card, `—` card for
  the other.

## Testing

No backend unit test — endpoint is a thin cached proxy over one Yahoo call
(same class as `/api/analysts`, which has none). Verification is live:
curl `/api/oil` for real values + both preview-render checks.

## Out of scope (YAGNI)

Historical chart/timeframes, Brent–WTI spread, INR/barrel, other commodities
(natgas, gold), alerts. All fit later without rework: chart via
`yahooFinance.chart()`, spread/INR derivable from this endpoint's data.

## Files touched

- `backend/server.js` — `/api/oil` endpoint + cache.
- `frontend/src/pages/marketData/OilTracker.jsx` — new page.
- `frontend/src/components/Navbar.jsx` — one sublink.
- `frontend/src/App.jsx` — one route.
