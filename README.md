# Kite Analytical Dashboard

A beautiful, real-time analytical dashboard for your Zerodha Kite portfolio — built with React + Node.js + Kite MCP.

## Features

- 📊 **Live Portfolio Overview** — equity & mutual fund holdings with P&L
- 📈 **Instrument Detail Page** — interactive price charts with timeframe switching (1D, 1W, 1M, 3M, 6M, 1Y, 5Y)
- 🔬 **Technical Indicators** — RSI, SMA (5/20/50/200), EMA (12/26), MACD, Bollinger Bands with **signal labels** (Bullish / Bearish / Neutral)
- 💼 **Portfolio Stats** — total invested, total returns, today's returns
- 🏦 **Major Indices Ticker** — live NIFTY 50, NIFTY BANK, and SENSEX performance on the dashboard
- 🌍 **Sector Indices Page** — sortable table of 25 major indices with:
  - Multi-period returns: **1D, 1W, 1M, 3M, 6M, 1Y, 3Y, 5Y**
  - Color-coded **sparklines** (green = above SMA50, red = below)
  - **RSI(14)** badge per index (green = oversold, red = overbought)
  - Live **search/filter** box
- 🔐 **Secure Auth** — MCP-based Zerodha OAuth with disconnect/reconnect support
- 🌙 **Dark Mode UI** — glassmorphism design with smooth animations

## Tech Stack

| Layer    | Tech                              |
|----------|-----------------------------------|
| Frontend | React 18, Vite, Recharts, react-router-dom |
| Backend  | Node.js, Express                  |
| API      | Kite MCP via `mcp-remote`        |
| Indicators | `technicalindicators` library  |
| Fundamentals | Yahoo Finance (`yahoo-finance2`) |

## Getting Started

### Prerequisites
- Node.js 18+
- A [Zerodha Kite](https://kite.zerodha.com) account

### 1. Backend

```bash
cd backend
npm install
node server.js
```

The backend runs on `http://localhost:3001` and connects to the Kite MCP server.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend runs on `http://localhost:5173`.

### 3. Authenticate

On first launch, click **Login to Kite** and authorize access via Zerodha.

## Project Structure

```
kite-dashboard/
├── backend/
│   ├── server.js          # Express API + MCP client + indicator calculations
│   └── package.json
└── frontend/
    ├── src/
    │   ├── pages/
    │   │   ├── Dashboard.jsx      # Main dashboard with Major Indices ticker
    │   │   ├── Portfolio.jsx      # Holdings & MF view
    │   │   ├── Instrument.jsx     # Stock detail + chart + indicators + signal labels
    │   │   ├── Alerts.jsx         # Portfolio-level technical alerts
    │   │   └── SectorIndices.jsx  # Sector indices table with returns, sparklines & RSI
    │   ├── components/
    │   │   └── Navbar.jsx
    │   └── App.jsx
    └── package.json
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/profile` | User profile |
| `GET /api/holdings` | Equity holdings |
| `GET /api/mf-holdings` | Mutual fund holdings |
| `GET /api/margins` | Account margins |
| `GET /api/historical/:token?tf=1M` | Price history (cached, up to 1Y) |
| `GET /api/historical-full/:token` | Full 5-year history in yearly chunks (for Sector Indices) |
| `GET /api/indicators/:token` | Technical indicators (RSI, SMA, EMA, MACD, BB) |
| `GET /api/fundamentals/:symbol` | Fundamental data via Yahoo Finance |
| `GET /api/cashflow/:symbol` | Cashflow data via Yahoo Finance |
| `GET /api/alerts` | Portfolio-level technical alerts |
| `POST /api/quotes` | Live quotes for multiple instruments |
| `POST /api/login` | Get Kite login URL |
| `POST /api/disconnect` | Clear session & caches |

## Notes on Data

- Historical data from Kite MCP is limited to ~1 year per API call. The `/api/historical-full` endpoint works around this by fetching data in yearly chunks and stitching them together.
- Multi-year returns (3Y, 5Y) are computed using the nearest available trading day to the target calendar date.
- Small discrepancies vs other platforms (Tijori, Moneycontrol) are expected due to different underlying data sources and price adjustments.
