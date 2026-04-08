# Kite Analytical Dashboard

A beautiful, real-time analytical dashboard for your Zerodha Kite portfolio — built with React + Node.js + Kite MCP.

## Features

- 📊 **Live Portfolio Overview** — equity & mutual fund holdings with P&L
- 📈 **Instrument Detail Page** — interactive price charts with timeframe switching (1D, 1W, 1M, 3M, 6M, 1Y, 5Y)
- 🔬 **Technical Indicators** — RSI, SMA (5/20/50/200), EMA (12/26), MACD, Bollinger Bands
- 💼 **Portfolio Stats** — total invested, total returns, today's returns
- 🔐 **Secure Auth** — MCP-based Zerodha OAuth with disconnect/reconnect support
- 🌙 **Dark Mode UI** — glassmorphism design with smooth animations

## Tech Stack

| Layer    | Tech                              |
|----------|-----------------------------------|
| Frontend | React 18, Vite, Recharts, react-router-dom |
| Backend  | Node.js, Express                  |
| API      | Kite MCP via `mcp-remote`        |
| Indicators | `technicalindicators` library  |

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
    │   │   ├── Dashboard.jsx      # Main dashboard
    │   │   ├── Portfolio.jsx      # Holdings & MF view
    │   │   └── Instrument.jsx     # Stock detail + chart + indicators
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
| `GET /api/historical/:token?tf=1M` | Price history |
| `GET /api/indicators/:token` | Technical indicators |
| `POST /api/login` | Get Kite login URL |
| `POST /api/disconnect` | Clear session & caches |
