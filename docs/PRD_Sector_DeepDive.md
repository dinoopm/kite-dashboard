# Sector Deep-Dive — Product Requirements Document

**Product:** Kite Analytics
**Feature:** Sector Deep-Dive View
**Status:** Draft v2.0 — updated to reflect actual project stack
**Date:** April 2026
**Author:** Product

---

## 1. Executive summary

When a user identifies a strong-performing sector from the Indices Performance view, they currently have no way to drill into it. They must cross-reference the sector with the Technical Alerts page and mentally filter stocks by sector — a manual, error-prone process that loses most of the analytical value of a sector signal.

This feature introduces a dedicated **Sector Deep-Dive** view, reached by clicking any sector card, chart dot, or table row on the Indices Performance page. The view applies an institutional 4-filter framework to every stock in the sector and surfaces ranked trade candidates with explicit, transparent reasoning.

The target user sees the sector winners in under 15 seconds and can justify every pick to a risk committee.

---

## 2. Problem statement

### Today's gaps

1. **No sector-to-stock traversal.** The app identifies leading sectors but doesn't answer "which stocks in the leading sector should I actually buy?"
2. **Wrong benchmark for stock selection.** The existing Technical Alerts ranks conviction against the broad market. Inside a leading sector, every stock looks strong against Nifty — user needs to see leadership within the sector itself.
3. **Snapshot signals hide institutional behaviour.** Money flow is shown as a single reading. Institutions accumulate over days and weeks; the user needs the persistence signal, not the spot reading.
4. **No F&O intelligence.** NSE publishes free OI data that separates smart-money conviction (long buildup) from weak rallies (short covering). Retail tools ignore this; institutional desks live on it.
5. **No risk framing.** The user isn't told whether the sector is a "buy the leader" thematic trade or a "spread across several names" stock-picker's market. This determines position sizing.

### Who feels these gaps

| User type | Pain point |
|---|---|
| **Active swing trader** | Spends 20 min cross-referencing sector to stock list, misses the entry |
| **PMS / portfolio builder** | No defensible process for stock selection within theme |
| **Retail investor following sectoral rotation** | Buys the most-in-the-news name (usually extended), underperforms |

---

## 3. Goals and non-goals

### Goals

- Let a user identify the best stock(s) within any sector in under 15 seconds.
- Provide explicit, filter-by-filter reasoning for every recommendation.
- Differentiate thematic trades from stock-picker's markets.
- Surface institutional signals (flow persistence, F&O positioning) retail tools miss.
- Feel native to the existing Kite Analytics aesthetic and data model.

### Non-goals

- Fundamentals / valuation modelling (this is a technical + flow tool).
- Order placement or brokerage integration (v2+).
- Custom user-defined filters (shipping with the 4 fixed filters; customisation is v3).
- Intraday / tick-level analysis (EOD + delayed intraday is sufficient).
- Options strategy builders (separate product area).

---

## 4. User stories

> **US-1.** As a swing trader, when I see Energy leading on the Indices page, I want to click it and see which Energy stocks to buy, so I can size up quickly before the move extends.

> **US-2.** As a portfolio manager, when I pick a stock, I want a one-line thesis explaining why each of the 4 filters pass or fail, so I can justify the trade to my risk committee.

> **US-3.** As a retail investor, I want to know whether the sector is a "thematic" trade or a "stock-picker's" trade, so I don't accidentally over-diversify or over-concentrate.

> **US-4.** As a derivatives trader, I want to see F&O positioning (long buildup vs short covering) for every stock in the sector, so I can confirm whether smart money agrees with the price move.

> **US-5.** As a user returning to a sector I analysed yesterday, I want to see what changed — new Core Buys, dropped candidates — so I don't re-analyse from scratch.

---

## 5. Core concept: the 4-filter framework

A stock is a high-conviction buy only when all four independent filters pass. The filters are deliberately independent — each measures something the others cannot.

### Filter 1 — Leadership (RS vs sector)

**Question it answers:** Is this stock leading its own peers?

**Inputs:**
- Stock price series (90 days) — from Kite MCP `getHistoricalData`
- Sector index price series (90 days) — same source

**Calculation:**
- Compute JdK RS-Ratio and RS-Momentum using stock vs sector index (not vs Nifty 50).
- Rank the stock within the sector on combined RS-Ratio × RS-Momentum score.
- Output: 0–100 score. Pass threshold: ≥ 70.

**Implementation note:** No external library needed — pure arithmetic on closing prices.

**Pass signal:** Stock is in the Leading quadrant of the intra-sector RRG.

### Filter 2 — Stage (where in the move?)

**Question it answers:** Is this early enough to enter with acceptable risk-reward?

**Inputs (all computable from `technicalindicators` package):**
- 200-period EMA and its slope → `EMA.calculate()`
- RSI(14) → `RSI.calculate()`
- VWAP(20) deviation → `VWAP.calculate()` — deviation = (price - vwap) / vwap × 100
- Distance from 52-week high — derived from price series, no library needed

**Calculation (Weinstein-derived):**
- Stage 1 (basing): below or near 200EMA, flat slope, low volatility → score 60
- Stage 2 early: above 200EMA, EMA rising, RSI 55–65, low VWAP dev → score 90
- Stage 2 mid: RSI 60–70, VWAP dev 5–10% → score 80
- Stage 2 late: RSI 68–75, VWAP dev 8–12% → score 60
- Stage 3 (topping): RSI > 72, VWAP dev > 12%, price near 52W high → score 30
- Stage 4 (declining): below 200EMA, EMA falling → score 10

**Pass threshold:** ≥ 60. Core Buy status requires ≥ 70.

**Important:** The `technicalindicators` package is already installed in `backend/`. Use it — do not reimplement EMA, RSI, or VWAP from scratch.

```js
const { EMA, RSI, VWAP } = require('technicalindicators')
const ema200 = EMA.calculate({ period: 200, values: closePrices })
const rsi14  = RSI.calculate({ period: 14, values: closePrices })
const vwap   = VWAP.calculate({ high, low, close, volume })
```

### Filter 3 — Flow (persistent accumulation)

**Question it answers:** Are institutions accumulating, or is this a retail-driven rally?

**Inputs:**
- Daily Money Flow Index (MFI-14) → `MFI.calculate()` from `technicalindicators`
- Daily delivery % → from `nse-js` `getDeliveryBhavcopy(date)` or Supabase cache
- Block deal data (30 days) → from `nse-js` `getBlockDeals()` or Supabase cache

**Calculation:**
- Count consecutive days with positive MFI (the "flow streak").
- Compare 10-day avg delivery % to 90-day avg; compute delta.
- Sum 30-day net block deal value.
- Composite: streak length (50%) + delivery delta (30%) + block deals (20%).

**Pass thresholds:**
- Strong: 7+ day streak, rising delivery, positive block deals → score 80+
- Moderate: 3–6 day streak → score 50–79
- Weak/fail: <3 days or negative streak → score <50

**Phase 1 note:** Ship with MFI streak only (data already in Supabase via Kite). Delivery % and block deals are Phase 3 enrichment.

### Filter 4 — F&O positioning

**Question it answers:** Does smart money (OI positioning) confirm the price move?

**Inputs:**
- 5-day futures price change → from Kite MCP `getHistoricalData(oi=true)` on NFO token
- 5-day OI change → same source
- Put-Call ratio → from `stock-nse-india` `getEquityOptionChain(symbol)` (Phase 2+)

**Calculation:** Categorical classification:

| Price 5D | OI 5D | Label | Signal |
|---|---|---|---|
| ↑ | ↑ | **Long buildup** | Bullish confirmation |
| ↑ | ↓ | **Short covering** | Weak rally, caution |
| ↓ | ↑ | **Short buildup** | Bearish confirmation |
| ↓ | ↓ | **Long unwinding** | Bulls exiting |

**Pass:** Long buildup (+25 to composite) or short covering with PCR < 0.8 (+10).
**Fail:** Short buildup or long unwinding.

**Note:** Non-F&O stocks skip this filter; composite is normalised over 3 filters with a max cap of 85.

### Composite score

```
Composite = (F1 × 0.30) + (F2 × 0.30) + (F3 × 0.25) + (F4 × 0.15)
```

Non-F&O fallback:
```
Composite = (F1 × 0.35) + (F2 × 0.35) + (F3 × 0.30)   // capped at 85
```

---

## 6. Meta-signals (sector-level context)

### Meta-1 — Dispersion

**Calculation:** Average pairwise correlation of 20-day returns across all sector constituents.

**Display:**
- `> 0.70`: "LOW dispersion — thematic trade. Buy the leaders, avoid over-diversifying."
- `0.40–0.70`: "MODERATE dispersion — mixed signals, selective."
- `< 0.40`: "HIGH dispersion — stock-picker's market, filter scores add significant alpha."

### Meta-2 — Breadth

**Metrics** (all derivable from Supabase historical candles):
- % of constituents above 50EMA
- % of constituents above 200EMA
- New 52W highs / lows today
- Advance/Decline ratio (5D)

### Meta-3 — Surveillance flag

Any stock in the ASM or GSM lists cannot be a Core Buy regardless of composite score.
- **Source:** `stock-nse-india` `getDataByEndpoint('/api/reportASM')` and `/api/reportGSM`
- **Storage:** `surveillance_stocks` Supabase table (already created)
- **Refresh:** Daily at server startup + 09:00 IST cron

---

## 7. Screen breakdown

### 7.1 Entry points

The deep-dive opens from any of these actions:
- Clicking a sector bar on the Top 10/Bottom 10 charts on the Indices Performance page
- Clicking a dot on the Relative Rotation Graph
- Clicking a row in the index heatmap table
- Direct URL `/sector/:slug` (shareable, handled by `react-router-dom` v7)

### 7.2 Layout (top to bottom)

| Zone | Purpose |
|---|---|
| Breadcrumb | Indices Performance / Sectors / Energy |
| Sector header card | Name, price, 1D/1M/3M, RS-Ratio, Momentum, RSI, quadrant chip, dispersion chip |
| Stats strip (3 cards) | Breadth · Flow & Delivery · F&O Positioning |
| Main grid (2 cols) | Intra-sector RRG · Leader/Laggard quadrant |
| Ranked picks (4 cards) | Core Buys · Extended Winners · Rebasing · Avoid |
| Filter matrix table | All constituents with 4-filter scores, stage, F&O, composite, verdict |
| Stock detail panel | Opens on row click — per-filter reasoning + thesis |

### 7.3 Charts

**Intra-sector RRG** — rendered with `recharts` ScatterChart. Each stock is a dot on RS-Ratio (X) vs RS-Momentum (Y) axes. Tail lines (7-week history per stock) require `d3-shape` line generator with a curve interpolator — `recharts` alone cannot produce curved tails.

**Leader/Laggard quadrant** — 2×2 matrix rendered with `recharts` ScatterChart. X = intra-sector RS score (F1), Y = Stage score (F2). Four coloured quadrant backgrounds rendered as custom `ReferenceArea` components.

---

## 8. Data sources mapped to actual packages

### What Kite MCP provides (via `@modelcontextprotocol/sdk`)

| Data | MCP call | Filter |
|---|---|---|
| OHLCV candles 250D | `get_historical_data` | F1, F2 |
| Live quotes | `get_quotes` (batch 500) | Live header |
| Futures OI history | `get_historical_data(oi=true)` on NFO token | F4 |
| Holdings | `get_holdings` | Exposure card (Phase 4) |
| Instruments list | `get_instruments('NFO')` | F4 contract lookup |

### What `technicalindicators` computes locally (already installed)

| Indicator | Package function | Filter |
|---|---|---|
| 200-period EMA + slope | `EMA.calculate()` | F2 |
| RSI(14) | `RSI.calculate()` | F2 |
| VWAP(20) deviation | `VWAP.calculate()` | F2 |
| MFI(14) streak | `MFI.calculate()` | F3 |
| Bollinger Band width | `BollingerBands.calculate()` | F2 volatility |

### What Supabase stores (tables already created)

| Table | Contents | Populated by |
|---|---|---|
| `participant_oi` | FII/DII/PRO/Client OI breakdown | Participant OI scraper |
| `fii_dii_activity` | Daily FII/DII net cash flow | FII/DII scraper (already built) |
| `surveillance_stocks` | ASM/GSM/ESM flags | Surveillance scraper |

### What `stock-nse-india` provides

| Method | Data | Filter |
|---|---|---|
| `getEquityStockIndices(index)` | Sector constituents + live prices | Universe bootstrap |
| `getEquityTradeInfo(symbol)` | Delivery % today | F3 |
| `getEquityOptionChain(symbol)` | PCR, IV, full option chain | F4 PCR (Phase 2) |
| `getEquityDetails(symbol)` | `isFNOSec` flag, lot size | F4 eligibility |
| `getDataByEndpoint('/api/reportASM')` | ASM list | Surveillance |
| `getDataByEndpoint('/api/reportGSM')` | GSM list | Surveillance |

### What `nse-js` provides

| Method | Data | Filter |
|---|---|---|
| `getDeliveryBhavcopy(date)` | Historical delivery % | F3 (Phase 3) |
| `getBlockDeals()` | Today's block deals | F3 (Phase 3) |
| `getFnoBhavcopy(date)` | Historical F&O OI | F4 backfill |
| `getNseHolidays()` | Trading calendar | getPrevTradingDay() |
| `listFnoStocks()` | F&O eligible symbols | F4 eligibility |
| `advanceDecline()` | A/D count per index | Breadth |

### What `yahoo-finance2` provides

| Use | Data | Notes |
|---|---|---|
| Macro context | Crude oil, DXY, US 10Y yield | Energy/IT sector context cards |
| Backup prices | Historical OHLCV | Fallback if Kite token expired |
| India VIX history | `^INDIAVIX` ticker | VIX page supplement |

### What `puppeteer` currently does (to be reviewed)

Puppeteer is used for NSE scraping where `stock-nse-india` and `nse-js` don't reach. Before adding any new Puppeteer scraper, check if the target data is available through one of those packages via `getDataByEndpoint()`. Keep Puppeteer only for pages that require JavaScript rendering with no underlying API.

### What `csv-parse` handles

All CSV parsing for NSE downloaded files. Use the streaming API for large bhavcopy files, the callback API for small surveillance CSVs:

```js
const { parse } = require('csv-parse')

// Large files (bhavcopy)
fs.createReadStream(filePath).pipe(parse({ columns: true, trim: true }))

// Small files (surveillance, ~50 rows)
parse(csvText, { columns: true, trim: true }, (err, records) => { ... })
```

---

## 9. Technical architecture

### Actual tech stack

**Backend (`backend/`):**
- Runtime: Node.js, **CommonJS** (`"type": "commonjs"`)
- Framework: Express v5
- Language: **JavaScript** (not TypeScript)
- Kite integration: `@modelcontextprotocol/sdk` — MCP client to `mcp.kite.trade/mcp`
- Technical indicators: `technicalindicators` — RSI, EMA, VWAP, MFI, etc.
- Supplementary prices: `yahoo-finance2`
- NSE scraping: `puppeteer` (current) + `cheerio` (HTML parsing)
- CSV parsing: `csv-parse`
- Environment: `dotenv`
- CORS: `cors`

**Missing from backend — must add before building:**
```bash
npm install @supabase/supabase-js   # database client
npm install bottleneck              # Kite MCP rate limiting
npm install node-cron               # EOD job scheduling
npm install stock-nse-india         # NSE sector data, ASM/GSM
npm install nse-js                  # bhavcopy, block deals, holidays
npm install pino                    # structured logging
```

**Frontend (`frontend/`):**
- Runtime: React 19 + Vite 8
- Language: **JavaScript** (not TypeScript)
- Routing: `react-router-dom` v7
- Charts: `recharts` v3
- Dates: `date-fns` v4
- Markdown: `react-markdown`

**Missing from frontend — must add before building:**
```bash
npm install @supabase/supabase-js   # direct Supabase reads for live data
npm install @tanstack/react-query   # server state, caching, background refresh
npm install @tanstack/react-table   # filter matrix table with sort/filter
npm install d3-shape d3-scale       # RRG tail curves (recharts can't do this)
npm install clsx                    # conditional classNames
npm install zustand                 # selected sector/stock global state
```

**Database: Supabase (PostgreSQL)**
Tables confirmed created:
- `participant_oi` — FII/DII/PRO/Client OI breakdown per day
- `fii_dii_activity` — daily net FII/DII cash flows
- `surveillance_stocks` — ASM/GSM/ESM flags with `current_surveillance` view

### Architecture pattern

```
Frontend (React)
    ↓ reads pre-computed snapshots
    → GET /api/sectors/:slug     (Express)
    → Supabase direct reads      (participant_oi, fii_dii_activity)

Backend (Express + Node.js)
    ↓ computes sector snapshots
    → Kite MCP  (historical candles, live quotes, OI)
    → technicalindicators  (EMA, RSI, VWAP, MFI locally)
    → stock-nse-india  (constituents, trade info, option chain)
    → nse-js  (bhavcopy, block deals, holidays)
    → Supabase  (read scraped data; write snapshots)

Scrapers (cron jobs)
    → participant_oi scraper  (16:00 IST daily)
    → fii_dii scraper         (already built)
    → surveillance scraper    (09:00 IST daily)
    → snapshot rebuilder      (hourly intraday + EOD)
```

### Performance target

First meaningful paint < 500ms. Achievable because sector snapshots are pre-computed and written to Supabase. Frontend reads one JSON blob per sector — no computation at render time.

### Rate limiting

Kite MCP enforces ~3 req/s for `get_historical_data`. Use `bottleneck`:

```js
const Bottleneck = require('bottleneck')
const limiter = new Bottleneck({ minTime: 350, maxConcurrent: 1 })
const getHistorical = limiter.wrap(kiteMcpClient.getHistoricalData.bind(kiteMcpClient))
```

### Routing

`react-router-dom` v7 routes:
- `/sector/:slug` — sector deep-dive (e.g. `/sector/nifty-energy`)
- Entry from Indices Performance page via `<Link to={/sector/${sector.slug}}>`

---

## 10. Phased rollout

### Phase 0 — Foundations (1 week, prerequisite)

**Backend:**
- Install missing packages (`@supabase/supabase-js`, `bottleneck`, `node-cron`, `stock-nse-india`, `nse-js`, `pino`)
- `kiteClient.js` — MCP wrapper with `bottleneck` rate limiting
- `tradingCalendar.js` — `getPrevTradingDay()` using `nse-js` `getNseHolidays()`
- `sectorConstituents.js` — sector→symbol mapping from `stock-nse-india` `getEquityStockIndices()`
- `foEligibility.js` — F&O symbol list from `nse-js` `listFnoStocks()`
- `surveillanceCache.js` — in-memory ASM/GSM Set, refreshed daily
- Supabase client (`supabaseAdmin` with service key, `supabasePublic` with anon key)
- `GET /api/health` returning cache freshness and Kite token status

**Frontend:**
- Install missing packages (`@tanstack/react-query`, `@supabase/supabase-js`, `@tanstack/react-table`, `d3-shape`, `d3-scale`, `clsx`, `zustand`)
- `QueryClient` setup in `main.jsx`
- Supabase client for direct reads
- Route `/sector/:slug` registered in router

### Phase 1 — MVP (2 weeks)

Ship with F1 + F2 only, sourced entirely from Kite MCP + `technicalindicators`.

**Backend:**
- `f1Leadership.js` — RS-Ratio and RS-Momentum computation
- `f2Stage.js` — Stage score using EMA/RSI/VWAP from `technicalindicators`
- `snapshotBuilder.js` — computes and writes sector snapshots to Supabase
- `jobs/snapshotRebuild.js` — `node-cron` hourly job
- `GET /api/sectors/:slug` — reads pre-computed snapshot from Supabase

**Frontend:**
- `SectorPage.jsx` — full page layout
- `SectorHeader.jsx` — metrics card
- `BreadthCard.jsx` — stat card
- `LeaderLaggardQuadrant.jsx` — recharts ScatterChart with quadrant backgrounds
- `RankedPicks.jsx` — 4 cards
- `FilterMatrix.jsx` — `@tanstack/react-table` with F1, F2, composite, verdict columns

### Phase 2 — F&O intelligence (2 weeks)

Add Filter 4 from Kite MCP futures OI.

- `f4Fno.js` — long/short buildup from 5D price + OI delta
- `foStat.jsx` — F&O stat card in stats strip
- F4 column on FilterMatrix
- Detail panel with all 4 filter breakdowns
- Intra-sector RRG chart (`recharts` + `d3-shape` tails)

### Phase 3 — External data enrichment (2 weeks)

Add delivery %, block deals from `nse-js`. Upgrade F3 from MFI-only to full score.

- `f3Flow.js` upgraded with delivery delta + block deals from Supabase
- `Flow & Delivery` stat card
- Day-over-day verdict change indicators ("new Core Buy", "dropped from Extended")
- `participant_oi` cards using Supabase data (already scraped)
- `fii_dii_activity` macro bar using Supabase data

### Phase 4 — Integrations (later)

- PCR from `stock-nse-india` `getEquityOptionChain()`
- IV percentile (Black-Scholes inversion — manual JS implementation)
- Portfolio exposure diff via Kite `get_holdings`
- Event calendar overlay (earnings from `nse-js` `boardMeetings()`)
- Concentration warnings

---

## 11. CommonJS migration note

The backend currently uses `"type": "commonjs"`. This works for now but creates friction:
- `kiteconnect` npm (if ever added) is ESM-only
- `stock-nse-india` works in both but is cleaner as ESM
- `nse-js` is CommonJS compatible

**Recommendation:** Migrate to `"type": "module"` and `import` syntax when the Phase 1 server is working. The migration cost is lowest now while file count is low. Migration steps: add `"type": "module"` to `package.json`, rename files to `.mjs` or convert all `require()` to `import`, update `module.exports` to `export default`.

Do not migrate mid-phase — choose a phase boundary.

---

## 12. Success metrics

| Metric | Current | Target (90 days post-launch) |
|---|---|---|
| Sessions touching Indices Performance | X | +40% |
| Clicks from Indices Performance to sector drill-down | ~0 | 1.5 per session |
| Sector deep-dive pages per session | 0 | 2.3 |
| % users who return within 24h | Z | +15 points |

### Qualitative success

- User can say "I can defend this trade" after using the detail panel
- Zero regression in Technical Alerts usage

---

## 13. Open questions

1. **CommonJS vs ESM migration timing.** Migrate at Phase 1 completion or Phase 2 start?
2. **Puppeteer replacement.** Which NSE pages require it vs can be served by `getDataByEndpoint()`? Map before Phase 3.
3. **Sector definitions.** Stock appears in multiple NSE indices (e.g. RELIANCE in Energy AND FMCG). Proposal: use `getEquityStockIndices()` as ground truth, allow multi-assignment.
4. **Non-F&O stocks.** Cap composite at 85 and flag `foAvailable: false`. Not blocking.
5. **Yahoo Finance as backup.** `yahoo-finance2` can supply prices when Kite token expires at 6 IST. Build the fallback into `kiteClient.js` or handle it at the snapshot level?
6. **Testing.** Neither Vitest nor Jest is installed. Add Vitest to both packages or use Node's built-in `node:test`?

---

## 14. Out of scope for this PRD

- TypeScript migration (project is JavaScript — do not convert during feature build)
- User-editable filter weights (v3+)
- Cross-sector screener (separate product)
- Backtesting harness (separate project)
- Alerting infrastructure (use existing Technical Alerts engine)

---

## Appendix A — Copy library

### Verdict labels

- **◆ CORE BUY** — all 4 filters pass, composite ≥ 80, not under ASM/GSM
- **◑ REBASING** — contrarian rotation candidate, F2 ≥ 70 but F1 weak
- **▲ BUY DIPS** — 3/4 filters pass, composite 70–79
- **▲ HOLD** — 2/4 filters pass, composite 50–69
- **● SELL** — F&O shows short buildup, composite < 40
- **● AVOID** — Stage 4 or 0/4 filters pass, composite < 30
- **⚠ SURVEILLANCE** — composite would qualify but ASM/GSM flag blocks Core Buy

### Stage pills

- **STAGE 1 BASE** · **STAGE 2 EARLY** · **STAGE 2 MID** · **STAGE 2 LATE**
- **STAGE 3 EARLY** · **STAGE 3 MID** · **STAGE 3 LATE** · **STAGE 4**

### F&O pills

- **LONG BUILDUP** (green) · **SHORT COVER** (gray) · **SHORT BUILDUP** (red) · **LONG UNWIND** (amber) · **NEUTRAL** (non-F&O)

---

## Appendix B — Key package reference

| Package | Location | Primary use |
|---|---|---|
| `@modelcontextprotocol/sdk` | backend | Kite MCP client — historical data, quotes, OI |
| `technicalindicators` | backend | EMA, RSI, VWAP, MFI, Bollinger — all F2/F3 math |
| `yahoo-finance2` | backend | Macro context, backup prices, VIX history |
| `stock-nse-india` | backend | Sector constituents, trade info, ASM/GSM |
| `nse-js` | backend | Bhavcopy, block deals, holidays, F&O list |
| `csv-parse` | backend | NSE CSV file parsing (bhavcopy, surveillance) |
| `puppeteer` | backend | NSE pages requiring JS rendering (minimise use) |
| `cheerio` | backend | HTML parsing of NSE responses |
| `bottleneck` | backend | Kite MCP rate limiting (add in Phase 0) |
| `node-cron` | backend | EOD job scheduling (add in Phase 0) |
| `@supabase/supabase-js` | backend + frontend | Database reads/writes |
| `recharts` | frontend | All charts (scatter, line, bar) |
| `@tanstack/react-query` | frontend | Server state, caching, background refresh |
| `@tanstack/react-table` | frontend | Filter matrix table |
| `d3-shape` + `d3-scale` | frontend | RRG tail curve paths |
| `react-router-dom` v7 | frontend | `/sector/:slug` routing |
| `date-fns` | frontend | Date formatting, trading day arithmetic |
| `clsx` | frontend | Conditional classNames |
| `zustand` | frontend | Selected sector/stock global state |

---

## Appendix C — Glossary

- **JdK RS-Ratio / RS-Momentum** — Julius de Kempenaer's Relative Rotation Graph inputs.
- **Stage analysis** — Stan Weinstein's four-phase price cycle framework.
- **MFI** — Money Flow Index. Volume-weighted RSI oscillator from `technicalindicators`.
- **Delivery %** — fraction of traded volume resulting in actual share delivery. Source: `nse-js`.
- **OI (Open Interest)** — total outstanding futures/options contracts. Source: Kite MCP `oi=true`.
- **PCR (Put-Call Ratio)** — put volume / call volume. Source: `stock-nse-india` option chain.
- **Dispersion** — average pairwise correlation of returns. Computed locally from Supabase candle data.
- **ASM/GSM** — Additional/Graded Surveillance Measure. SEBI restriction that blocks Core Buy verdict.
- **Snapshot** — pre-computed sector analysis JSON blob written to Supabase, read by frontend.
