# Kite Analytical Dashboard

A real-time analytical dashboard for your Zerodha Kite portfolio — built with React + Node.js + Kite MCP, augmented with NSE surveillance data and FII/DII flows.

## Features

### 📊 Dashboard
- **Live Major Indices Ticker** — NIFTY 50, NIFTY BANK, SENSEX
- **FII/DII Activity Widget** — daily institutional flows with running **Net Flow** total, sourced from the NSE data archive and persisted in Supabase
- **Participant OI** — derivative open-interest positioning by participant category (FII, DII, Pro, Client)
- **Portfolio summary panel** — invested, returns, today's P&L

### 💼 Portfolio
- Equity & mutual fund holdings with live P&L
- **Day change sortable by %**, not just absolute rupee value
- **ASM / GSM surveillance badges** — flags stocks under NSE Additional/Graded Surveillance, scraped from the NSE site via Puppeteer
- Click any row → instrument detail page

### 📈 Instrument Detail
- Interactive price charts with timeframe switching (1D, 1W, 1M, 3M, 6M, 1Y, 5Y)
- **Technical indicators** — RSI, SMA (5/20/50/200), EMA (12/26), MACD, Bollinger Bands
- **Signal labels** — Bullish / Bearish / Neutral per indicator
- **Fundamentals & Cashflow** via Yahoo Finance

### 🚨 Technical Alerts (Portfolio-wide)
Portfolio-level technical scanner with per-stock conviction scoring and trade plans:

- **Bullish Bias score (0–100)** — stacked points from RSI zone, SMA alignment, VWAP deviation, money flow, trend regime, and price leadership. Clickable modal shows the full breakdown (positive/negative contributors) and "How it works" explainer
- **Trade plan tag** per row: `BUY SEEN` / `BREAKOUT (CAUTION)` / `BREAKOUT (WEAK)` / `HOLD / WAIT` / `HOLD (OVERBOUGHT)` / `SELL (AT RANGE)` / `AVOID`, with target, stop-loss, and reward-to-risk ratio. R:R gate demotes weak setups automatically
- **Regime classifier** — `STRONG TREND` (with BULL/BEAR direction), `RANGE-BOUND`, `WILD SWINGS`. Flash-move detection trips WILD SWINGS when a single bar exceeds 2× ATR14 or 4% of price, so one-day crashes don't look "trendy"
- **Money Flow gauge** — Chaikin-style accumulation/distribution bar per stock
- **Direction-aware volume confirmation** — green ✓ on up days with ≥1.5× avg volume (accumulation), **red ✗** on down days with ≥1.5× avg volume (distribution)
- **DAY %** next to price (today's move vs previous close) and **vs 20D AVG** stretch gauge (distance from 20-day VWAP, a mean-reversion signal — *not* today's change)
- **BULL / BEAR / Breakout tabs** classified by bullish-bias score (>60 bull, <40 bear), with BEAR tab sorted most-bearish first
- **Cmd+K search** across symbols
- Candle cache refreshes **today's partial daily bar** on demand (1×/min/token) so volume, day-change, and surge confirmation reflect live intraday state, not yesterday's close

### 🌍 Sector Indices
- Sortable table of 25 major indices with multi-period returns (1D, 1W, 1M, 3M, 6M, 1Y, 3Y, 5Y)
- Color-coded sparklines (green above SMA50, red below)
- RSI(14) badge per index
- Live search filter

### 📉 VIX Index
- Dedicated page for India VIX — volatility regime, chart, and historical context

### 🔐 Auth & UX
- MCP-based Zerodha OAuth with disconnect/reconnect
- Dark-mode glassmorphism UI with smooth animations

---

## Tech Stack

| Layer        | Tech                                                     |
|--------------|----------------------------------------------------------|
| Frontend     | React 18, Vite, Recharts, react-router-dom               |
| Backend      | Node.js, Express                                         |
| Broker API   | Kite MCP via `mcp-remote`                                |
| Indicators   | `technicalindicators` library                            |
| Fundamentals | Yahoo Finance (`yahoo-finance2`)                         |
| Scrapers     | Puppeteer (NSE surveillance), Cheerio/HTTP (FII/DII, Participant OI) |
| Storage      | Supabase (FII/DII, Participant OI, surveillance snapshots) |
| Automation   | GitHub Actions — daily FII/DII sync, daily surveillance sync |

---

## Getting Started

### Prerequisites
- Node.js 18+
- A [Zerodha Kite](https://kite.zerodha.com) account
- *(Optional)* A Supabase project if you want FII/DII, Participant OI, and surveillance features to persist across restarts

### Environment

Create a `.env` at the project root:

```
PORT=3001
SUPABASE_URL=...              # optional, for FII/DII + surveillance
SUPABASE_SERVICE_KEY=...      # optional
```

If Supabase isn't configured, the institutional/surveillance endpoints return 500 but the rest of the app works normally.

### Setup & Run (Local / Production)

```bash
# 1. Install all dependencies (frontend & backend) and build the React app
npm run build

# 2. Start the production server (serves API + Frontend on port 3001)
npm start
```

Open `http://localhost:3001`.

### Local Development (Hot Reloading)

```bash
# Terminal 1 — backend API
cd backend && npm start

# Terminal 2 — Vite dev server (proxies /api → backend)
cd frontend && npm run dev
```

Dev server: `http://localhost:5173`.

### Authenticate
On first launch, click **Login to Kite** and authorize access via Zerodha.

---

## Project Structure

```
kite-dashboard/
├── backend/
│   ├── server.js               # Express API + MCP client + indicator/alert engine
│   ├── scraper/
│   │   ├── sync.js             # Entry point for the daily FII/DII sync job
│   │   ├── participant_oi.js   # NSE participant-wise OI → Supabase
│   │   └── surveillance.js     # NSE ASM/GSM list → Supabase (Puppeteer)
│   └── package.json
├── frontend/
│   └── src/
│       ├── pages/
│       │   ├── Dashboard.jsx       # Indices + FII/DII + Participant OI widgets
│       │   ├── Portfolio.jsx       # Holdings with ASM/GSM badges
│       │   ├── Instrument.jsx      # Chart + indicators + fundamentals
│       │   ├── Alerts.jsx          # Technical alerts + bullish bias + trade plans
│       │   ├── SectorIndices.jsx   # 25 indices table
│       │   └── VixIndex.jsx        # India VIX
│       ├── components/
│       │   └── Navbar.jsx
│       └── App.jsx
├── docs/
│   └── PRD_Sector_DeepDive.md
└── .github/workflows/
    ├── fii_dii_sync.yml            # Daily FII/DII ingest
    └── surveillance_sync.yml       # Daily ASM/GSM ingest
```

---

## API Endpoints

### Core (Kite-backed)
| Endpoint | Description |
|----------|-------------|
| `GET /api/profile` | User profile |
| `GET /api/holdings` | Equity holdings |
| `GET /api/mf-holdings` | Mutual fund holdings |
| `GET /api/margins` | Account margins |
| `GET /api/positions` | F&O positions |
| `GET /api/historical/:token?tf=1M` | Price history (cached, up to 1Y per call) |
| `GET /api/historical-full/:token` | Full 5-year history, stitched from 1Y chunks |
| `GET /api/indicators/:token` | Technical indicators with Bull/Bear/Neutral labels |
| `GET /api/alerts` | Portfolio-level alerts: bullish bias, trade plan, regime, volume |
| `GET /api/rrg` | Relative Rotation Graph (sector momentum vs benchmark) |
| `POST /api/quotes` | Live quotes for multiple instruments |

### Fundamentals (Yahoo-backed)
| Endpoint | Description |
|----------|-------------|
| `GET /api/fundamentals/:symbol` | Summary, valuation, growth |
| `GET /api/cashflow/:symbol` | Cashflow statement |

### Institutional & Surveillance (Supabase-backed)
| Endpoint | Description |
|----------|-------------|
| `GET /api/fiidii` | Last 10 days of FII/DII cash-market flows |
| `GET /api/participant-oi` | Last 20 days of participant-wise OI |
| `GET /api/surveillance` | Current NSE ASM/GSM list |

### Session
| Endpoint | Description |
|----------|-------------|
| `POST /api/login` | Get Kite login URL |
| `POST /api/reconnect` | Re-establish MCP session after disconnect |
| `POST /api/disconnect` | Clear session & caches |
| `GET /api/cache-status` | Inspect instrument-cache warmup state |

---

## Notes on Data

- Historical data from Kite MCP is limited to ~1 year per call. `/api/historical-full` works around this by fetching year-by-year and stitching.
- Multi-year returns (3Y, 5Y) use the nearest available trading day to the target calendar date.
- The alerts engine caches daily candles once per boot and refreshes **only today's partial bar** on demand (60s cooldown per token), so intraday price/volume/day-change stay live without re-pulling full history.
- FII/DII, Participant OI, and surveillance data are ingested by GitHub Actions cron jobs into Supabase. The app reads from Supabase, not directly from NSE at request time — so these features require the daily sync to be running.
- Small discrepancies vs other platforms (Tijori, Moneycontrol) are expected due to different data sources and price adjustments.
