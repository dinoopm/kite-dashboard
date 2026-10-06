# Kite Analytical Dashboard

A real-time analytical dashboard for your Zerodha Kite portfolio — built with React + Node.js + Kite MCP, augmented with NSE surveillance data, FII/DII flows, and volume analytics.

## Features

### 📊 Dashboard
- **Live Major Indices Ticker** — NIFTY 50, NIFTY BANK, SENSEX
- **FII/DII Activity Widget** — daily institutional flows with running **Net Flow** total, sourced from the NSE data archive and persisted in Supabase
- **Participant OI** — derivative open-interest positioning by participant category (FII, DII, Pro, Client)
- **Top Gainers / Losers** — NSE top movers across indices (NIFTY, BANKNIFTY, allSec, etc.), synced daily
- **Portfolio summary panel** — invested, returns, today's P&L

### 💼 Portfolio
- Equity & mutual fund holdings with live P&L
- **Holdings count stat card** — total number of distinct equity positions at a glance
- **Allocation % column** — each stock's weight in the portfolio by current value, sortable
- **T1-aware quantities** — unsettled (T+1) shares are included in all totals, invested amounts, and allocation calculations
- **Day change sortable by %**, not just absolute rupee value
- **ASM / GSM surveillance badges** — flags stocks under NSE Additional/Graded Surveillance
- **Technical Alerts quick-link** in the tab row alongside Equities / Mutual Funds
- Click any row → instrument detail page

### 📈 Instrument Detail
- Interactive price charts with timeframe switching (1D, 1W, 1M, 3M, 6M, 1Y, 5Y)
- **Technical indicators** — RSI, SMA (5/20/50/200), EMA (12/26), MACD, Bollinger Bands
- **Signal labels** — Bullish / Bearish / Neutral per indicator
- **Fundamentals & Cashflow** via Yahoo Finance
- **Quarterly Results** — last 4 quarters from screener.in with YoY/QoQ growth pills and trend sparklines. Rows: **Sales · Expenses · Operating Profit · Operating Margin · Net Profit · EPS**. Expenses use inverted polarity so rising costs render red.

### 🚨 Technical Alerts (Portfolio-wide)
Portfolio-level technical scanner with per-stock conviction scoring and trade plans:

- **Bullish Bias score (0–100)** — stacked points from RSI zone, SMA alignment, VWAP deviation, money flow, trend regime, and price leadership. Clickable modal shows the full breakdown and "How it works" explainer
- **Trade plan tag** per row: `STRONG BUY` / `STRONG BUY (DIV WARN)` / `STRONG BUY (UNCONFIRMED)` / `TRENDING (WAIT)` / `CHOPPY` / `BEARISH` / `BUY SEEN` / `BREAKOUT (CAUTION)` / `BREAKOUT (WEAK)` / `HOLD / WAIT` / `HOLD (OVERBOUGHT)` / `SELL (AT RANGE)` / `AVOID`, with target, stop-loss, and reward-to-risk ratio
- **Supertrend + RSI + ADX entry rule** — `STRONG BUY` requires five filters to align: ADX(14) ≥ 25 (real trend, not chop), Supertrend(10,3) green, price > 200 EMA, RSI in the 60-70 momentum band, volume ≥ 1.2× the 20-day average, and the broader bullish-bias score ≥ 70. ADX below 25 → `CHOPPY` (signals suppressed). Volume or conviction missing → `STRONG BUY (UNCONFIRMED)`. Stop-loss trails the Supertrend line.
- **ADX(14) badge** alongside the Supertrend chip — green ≥25 (trending), amber 20-25 (borderline), slate <20 (sideways)
- **Multi-window breakout ladder** — scans 6 historical windows (1M, 3M, 6M, 1Y, 2Y, 3Y) against full price history. Each broken window is highlighted green; the badge shows the longest cleared window (e.g. `🚀 3Y BREAKOUT`). Nearest unbroken overhead acts as next resistance
- **52-week high/low breakout** — dedicated alert when price clears or falls below the 52-week range
- **Regime classifier** — `STRONG TREND` (BULL/BEAR), `RANGE-BOUND`, `WILD SWINGS`
- **Money Flow gauge** — Chaikin-style accumulation/distribution bar per stock
- **Direction-aware volume confirmation** — green ✓ on up days with ≥1.5× avg volume, red ✗ on down days with ≥1.5× avg volume
- **DAY %** next to price and **vs 20D AVG** stretch gauge
- **BULL / BEAR tabs** classified by bullish-bias score (>60 bull, <40 bear)
- **Cmd+K search** across symbols
- Today's partial daily bar refreshes on demand (1×/min/token) so intraday volume and day-change stay live

### 🌍 Sector Indices
- Sortable table of 25 major indices with multi-period returns: 1D, 1W, 1M, 3M, 6M, 1Y, **2Y**, 3Y
- Color-coded sparklines (green above SMA50, red below)
- RSI(14) badge per index
- Live search filter and CSV export

### 📉 VIX Index
- Dedicated page for India VIX — volatility regime, chart, and historical context

### 🔐 Auth & UX
- MCP-based Zerodha OAuth with disconnect/reconnect
- Dark-mode glassmorphism UI with smooth animations

---

## Tech Stack

| Layer        | Tech                                                                          |
|--------------|-------------------------------------------------------------------------------|
| Frontend     | React 18, Vite, Recharts, react-router-dom                                    |
| Backend      | Node.js, Express                                                              |
| Broker API   | Kite MCP via `mcp-remote`                                                     |
| Indicators   | `technicalindicators` library                                                 |
| Fundamentals | Yahoo Finance (`yahoo-finance2`)                                              |
| Scrapers     | Puppeteer (NSE gainers, volume spurts, surveillance), Cheerio/HTTP (FII/DII, OI) |
| Storage      | Supabase (FII/DII, OI, top gainers/losers, volume gainers, surveillance)      |
| Automation   | GitHub Actions — daily market data sync, weekly surveillance sync             |

---

## Getting Started

### Prerequisites
- Node.js 18+
- A [Zerodha Kite](https://kite.zerodha.com) account
- *(Optional)* A Supabase project for institutional data, gainers/losers, and volume analytics

### Environment

Create a `.env` at the project root:

```
PORT=3001
SUPABASE_URL=...              # optional, for FII/DII + surveillance + gainers
SUPABASE_SERVICE_KEY=...      # optional
```

If Supabase isn't configured, the institutional/surveillance endpoints return 500 but the rest of the app works normally.

### Setup & Run

```bash
# Install all dependencies and build the React app
npm run build

# Start the production server (serves API + Frontend on port 3001)
npm start
```

Open `http://localhost:3001`.

### Local Development

```bash
# Terminal 1 — backend API
cd backend && npm start

# Terminal 2 — Vite dev server (proxies /api → backend)
cd frontend && npm run dev
```

Dev server: `http://localhost:5173`.

---

## Project Structure

```
kite-dashboard/
├── backend/
│   ├── server.js               # Express API + MCP client + indicator/alert engine
│   ├── scraper/
│   │   ├── sync.js             # FII/DII daily sync
│   │   ├── participant_oi.js   # NSE participant-wise OI → Supabase
│   │   ├── large_deals.js      # NSE bulk/block deals → Supabase
│   │   ├── top_gainers_losers.js  # NSE top gainers/losers → Supabase
│   │   ├── volume_gainers.js   # NSE volume spurts → Supabase
│   │   ├── fifty_two_week_high_low.js  # NSE 52-week H/L daily snapshot → Supabase
│   │   └── surveillance.js     # NSE ASM/GSM list → Supabase
│   └── package.json
├── frontend/
│   └── src/
│       ├── pages/
│       │   ├── Dashboard.jsx       # Indices + FII/DII + Participant OI + top movers
│       │   ├── Portfolio.jsx       # Holdings with allocation %, holdings count, ASM badges
│       │   ├── Instrument.jsx      # Chart + indicators + fundamentals
│       │   ├── Alerts.jsx          # Multi-window breakout + bias score + trade plans
│       │   ├── SectorIndices.jsx   # 25 indices table with 2Y return column
│       │   ├── SectorDetail.jsx    # Sector deep-dive with RRG
│       │   └── VixIndex.jsx        # India VIX
│       ├── components/
│       │   ├── Navbar.jsx
│       │   └── alerts/
│       └── App.jsx
└── .github/workflows/
    ├── fii_dii_sync.yml            # Weekday sync: FII/DII, OI, deals, gainers, volume spurts
    └── surveillance_sync.yml       # Weekly ASM/GSM ingest (Saturday)
```

---

## API Endpoints

### Core (Kite-backed)
| Endpoint | Description |
|----------|-------------|
| `GET /api/profile` | User profile |
| `GET /api/holdings` | Equity holdings (includes T1 unsettled quantities) |
| `GET /api/mf-holdings` | Mutual fund holdings |
| `GET /api/margins` | Account margins |
| `GET /api/positions` | F&O positions |
| `GET /api/historical/:token?tf=1M` | Price history (cached, up to 1Y per call) |
| `GET /api/historical-full/:token` | Full 5-year history, stitched from 1Y chunks |
| `GET /api/indicators/:token` | Technical indicators with Bull/Bear/Neutral labels |
| `GET /api/alerts` | Portfolio alerts: bias score, trade plan, regime, multi-window breakout |
| `GET /api/alerts/track-record` | Immutable live-alert observations, versioned input snapshots, horizon returns and adverse moves |
| `GET /api/rrg` | Relative Rotation Graph (sector momentum vs benchmark) |
| `POST /api/quotes` | Live quotes for multiple instruments |

### Fundamentals (Yahoo-backed)
| Endpoint | Description |
|----------|-------------|
| `GET /api/fundamentals/:symbol` | Summary, valuation, growth |
| `GET /api/cashflow/:symbol` | Cashflow statement |

### Institutional & Market Data (Supabase-backed)
| Endpoint | Description |
|----------|-------------|
| `GET /api/fiidii` | Last 10 days of FII/DII cash-market flows |
| `GET /api/participant-oi` | Last 20 days of participant-wise OI |
| `GET /api/surveillance` | Current NSE ASM/GSM list |
| `GET /api/top-gainers-losers` | Top price gainers/losers by index and category |
| `GET /api/volume-gainers` | Volume spurts — stocks with unusual volume vs 1W/2W average |

### Session
| Endpoint | Description |
|----------|-------------|
| `POST /api/login` | Get Kite login URL |
| `POST /api/reconnect` | Re-establish MCP session after disconnect |
| `POST /api/disconnect` | Clear session & caches |
| `GET /api/cache-status` | Inspect instrument-cache warmup state |

---

## Notes on Data

- Historical data from Kite MCP is limited to ~1 year per call. `/api/historical-full` stitches year-by-year chunks to support multi-year breakout scanning.
- T1 (unsettled) quantities are included in portfolio totals, allocation %, and invested amounts — newly bought shares appear correctly on trade date.
- The alerts engine caches daily candles once per boot and refreshes only today's partial bar on demand (60s cooldown per token).
- All NSE market data (FII/DII, OI, gainers, volume spurts) is ingested by GitHub Actions into Supabase. The app reads from Supabase at request time — these features require the daily sync to be running.
- Volume gainers data comes from NSE's `/api/live-analysis-volume-gainers` endpoint, showing stocks with unusual volume vs their 1-week and 2-week averages.
- If a sector constituent is dark on NSE (e.g. a trading suspension) but still trades on BSE under the same ISIN, the Sector Detail *Stocks* tab falls back to the BSE listing — resolving the instrument token from the instruments master and deriving price, 1D, and multi-year history from BSE — so the row still loads instead of showing a blank dash. Such rows have no live NSE tick, so their price and 1D come from the last (and prior) daily closes rather than real-time.
- Small discrepancies vs other platforms are expected due to different data sources and price adjustments.

### Signal observations and outcomes

Alerts displays heuristic bullish-bias points as **score/100**. The score is not a calibrated probability of a profitable trade. Open **Recorded signal outcomes** on `/alerts` to inspect results at 5, 10 and 22 subsequent trading sessions, grouped by action, score band and rule version. Samples below 20 resolved observations are marked too small to judge.

The first displayed portfolio alert for each action, symbol, India date and rule version is written to the existing `signal_emissions.meta` JSON column. Its evaluated time, holdings retrieval time, quote, full causal OHLCV input snapshot, derived metrics, score components, output and illustrative cost model are saved. Duplicate reads and restarts use insert-only conflict handling; later data never rewrites that observation. Live observations are recorded when `/api/alerts` is read, so this is a page-view sample, not a comprehensive signal census or independent trade sample. Recording failures are visible and retried on subsequent reads. Signals still load if storage is unavailable.

Rule fingerprints include the alert function, shared indicator math and indicator-library version. Registry price detectors also store versioned causal input windows and a digest of their preceding history; those recomputed emissions remain explicitly `reconstructed`. Physical storage keys include the rule version, allowing versions on the same day to coexist. Legacy observations retain unknown versions and missing inputs. Historical published-pick snapshots cannot retroactively acquire the rules or inputs that were not captured at publication.

Outcomes model a hypothetical long holding from the observed quote (live alerts) or signal-day close (registry signals) to a horizon close. Net returns assume **10 bps fees plus 5 bps slippage per side**, frozen with new observations. These are illustrative all-in assumptions, not broker-specific fees or executed trade P&L. Net gain/loss/flat counts reflect that model. Bearish warnings are measured as subsequent long-holding outcomes, not simulated shorts. Maximum adverse movement is the largest percentage fall to a later session low, excluding the observation-day low. Missing lows make path measurements unavailable; missing entry/exit dates and recent horizons remain unresolved. Prices are not split-adjusted, so corporate actions can distort these measurements.

No database migration is required if `signal_emissions` already exists. Full stored candle inputs are not downloaded to calculate the scorecard: it reads compact JSON projections and recent derived metrics. New live track-record reads are manual, with no additional polling. NSE and BSE observations have separate storage keys. Outcome prices currently come from NSE bhavcopy; BSE outcomes remain unresolved rather than using another exchange's prices.

### India macro releases

`/market-data/macro` displays **Latest available releases** from official sources, independently of the historical Indian Data Project charts. `GET /api/india-macro` reads stored releases and check status; `POST /api/india-macro/refresh` checks sources manually with a one-minute cooldown. The existing `/api/macro-overview` contract and historical series remain intact.

The backend checks six series daily, retries failed series after 15 minutes with exponential backoff capped at six hours, and coalesces concurrent checks with at most three sources in flight. `.github/workflows/india_macro_sync.yml` checks daily at **13:30 UTC (19:00 IST)** even when the laptop/backend is off, and can be run through workflow dispatch. The workflow must be on the GitHub default branch, with the existing `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` repository secrets configured. Run `node backend/indiaMacro/ingest.js --force` for a manual shared sync; a failed source or shared persistence sets a nonzero exit code so Actions reports the failure.

Sources: RBI Current Rates and dynamically discovered MPC statements; RBI Weekly Statistical Supplement for reserves; MoSPI's official CPI and National Accounts APIs (discovered base years and national/combined filters); the latest quarterly Balance of Payments link on RBI's NSDP page; and the latest published CGA monthly accounts for the current/previous fiscal year. MoSPI's TLS terminator currently needs legacy initial-server negotiation in Node; the compatibility agent is restricted to `api.mospi.gov.in` and keeps certificate verification enabled. Parsers fail closed on changed layouts, missing values, unexpected hosts, truncated responses, future reference dates and inconsistent units/columns.

Validated observations include value, units, reference period, official source URL, estimate status, publication date when supplied, and the app's first-seen timestamp. CPI/GDP APIs and CGA tables do not always supply a publication date: the UI explicitly reports it unavailable and never substitutes the fetch date. Fiscal cards are cumulative **rupee actuals and percent of the full-year budget**, not an invented monthly deficit/GDP ratio. Current-account deficits are negative; reserves are converted from USD million to billion. GDP uses constant-price YoY growth, not nominal growth.

Public economic data/checkpoints are stored in the private Supabase Storage bucket **`india-macro-releases`**, created automatically by the service role. No new database table or migration is needed. Checkpoints are immutable, include changed-value/estimate-status revisions (including same-day changes), and survive restarts. Unchanged readings do not acquire new first-seen dates; older source responses do not roll the newest reference period backward. `backend/data/india-macro/` is an ignored atomic local fallback cache. Shared-storage failures are displayed as local-only persistence; scheduled retries try again. No holdings, credentials or broker data are saved in this bucket.

Cards separately display the data period, actual/estimate status, publication date, first-seen date, last check, and failures. Failed refreshes keep the last successful release with a visible warning. Source checks older than two days are flagged; period-age tolerances are 3 days for current-rate snapshots, 80 for monthly CPI, 160 for quarterly GDP, 100 for fiscal YTD, 190 for quarterly current-account releases and 21 for weekly reserves. These are conservative publication-window checks, not a claim that a newer release exists. The historical charts explicitly retain their dataset fiscal year and source-summary update date, and identify estimates/projections separately from current cards.

Deterministic tests: `cd backend && node --test indiaMacro/*.test.js`. They do not contact official sources, Supabase or the broker.
