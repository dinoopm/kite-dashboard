# Kite Analytics — project context

## What this app is
A read-only equity analytics app for Indian markets (NSE). Built with a Node.js
CommonJS backend and React 19 frontend. Already shipped: Dashboard, Portfolio,
Technical Alerts, Indices Performance, VIX Index pages.
Currently building: Sector Deep-Dive (see PRD_Sector_DeepDive.md).

## Tech stack — exact versions, do not deviate

### Backend (backend/)
- Runtime: Node.js, "type": "commonjs" — use require(), not import
- Language: JavaScript (NOT TypeScript — do not add .ts files or tsconfig)
- Framework: Express v5
- Kite Connect: @modelcontextprotocol/sdk — MCP client to mcp.kite.trade/mcp
  This IS the Kite integration. Do not add the kiteconnect npm package.
- Technical indicators: technicalindicators — EMA, RSI, VWAP, MFI already installed
  USE IT. Never reimplement EMA, RSI, or VWAP from scratch.
- Supplementary prices: yahoo-finance2 — backup source and macro data
- NSE scraping: puppeteer + cheerio — use only when stock-nse-india can't reach the data
- CSV parsing: csv-parse — NOT papaparse
- Environment: dotenv
- CORS: cors
- Database: @supabase/supabase-js (service key for writes, anon key for reads)
- Rate limiting: bottleneck (wraps all Kite MCP calls)
- Scheduling: node-cron (EOD jobs)
- NSE data: stock-nse-india (constituents, trade info, ASM/GSM)
- NSE EOD files: nse-js (bhavcopy, block deals, holidays, F&O list)
- Logging: pino (structured JSON — never console.log in production code)

### Frontend (frontend/)
- Runtime: React 19 + Vite 8
- Language: JavaScript (NOT TypeScript — no .ts/.tsx files)
- Routing: react-router-dom v7
- Charts: recharts v3 (most charts)
- No Redux, no MobX, no Context for server state.

### Database: Supabase (PostgreSQL)
Tables already created:
- participant_oi      — FII/DII/PRO/Client OI breakdown per day
- fii_dii_activity    — daily net FII/DII cash flows
- surveillance_stocks — ASM/GSM flags

## Kite MCP etiquette — non-negotiable
1. Frontend NEVER calls Kite MCP directly. Backend only.
2. Rate limits: ~3 req/s for get_historical_data, ~1 req/s for get_quotes.
3. get_quotes accepts up to 500 instruments per call. Always batch.
4. Historical data is fetched nightly by cron job. Never fetch on page load.
5. KiteTicker WebSocket for live data. Polling get_quotes is fallback only.
6. Tokens expire at 06:00 IST daily. TokenManager handles daily refresh.

## JavaScript conventions (backend)
- CommonJS only: const x = require('x'), module.exports = { fn }
- Async/await everywhere, never .then() chains
- Never swallow errors — always try/catch with meaningful error messages
- Validate all external data manually
- Dates as ISO strings at API boundaries

## JavaScript conventions (frontend)
- React hooks only, no class components
- clsx for conditional className logic

## Aesthetic lock
- Background: #071019 (page), #111d2e (cards)
- Text: #e6ecf3 (primary), #8a96a8 (dim), #5a6579 (muted)
- Accents: #4cc9f0 (cyan), #22d3a0 (green/bullish), #f87171 (red/bearish),
  #fbbf24 (amber/warning), #64748b (gray/neutral)
- Font: Inter (UI), JetBrains Mono (numbers)
- Border radius: 14px cards, 8px inner, 4px pills
- No gradients, no drop shadows, no emoji in UI

## Current File Structure
backend/
  server.js              # Express entry point
  package.json
  scraper/
    sync.js              # FII/DII scraper (node-cron daily)
    participant_oi.js    # Participant OI scraper (node-cron daily)
    surveillance.js      # ASM/GSM scraper (Puppeteer)

frontend/src/
  App.jsx                # Main layout and routing
  pages/
    Dashboard.jsx        # Main overview
    Portfolio.jsx        # Holdings and mutual funds
    Alerts.jsx           # Technical alerts (golden cross, etc)
    Instrument.jsx       # Individual stock details
    SectorIndices.jsx    # Sector performance overview
    VixIndex.jsx         # India VIX tracker
  components/
    Navbar.jsx

.github/workflows/
  fii_dii_sync.yml       # FII/DII & Participant OI sync automation
  surveillance_sync.yml  # ASM/GSM weekly sync automation

## Planned File Structure (Sector Deep-Dive Phase)
backend/
  kiteClient.js          # MCP wrapper + bottleneck rate limiting
  tokenManager.js        # daily Kite token refresh
  tradingCalendar.js     # getPrevTradingDay()
  sectorConstituents.js  # slug → symbols map
  compute/
    f1Leadership.js      # RS-Ratio, RS-Momentum
    f2Stage.js           # Stage score using technicalindicators
    f3Flow.js            # MFI streak
    f4Fno.js             # long/short buildup from OI delta
    composite.js         # weighted composite + verdict

frontend/src/
  pages/
    sector/
      SectorPage.jsx
  components/
    sector/
      SectorHeader.jsx
      BreadthCard.jsx
      IntraSectorRRG.jsx
  store/
    sectorStore.js       # zustand: selectedSector, selectedStock
  lib/
    supabase.js          # Supabase anon client for direct reads
    tradingDays.js       # date-fns helpers

## Do not touch without explicit instruction
- frontend/src/pages/Alerts.jsx           (shipped, stable)
- frontend/src/pages/SectorIndices.jsx    (shipped, linking FROM it)
- backend/scraper/sync.js                 (scraper already built and working)
- backend/scraper/participant_oi.js       (scraper already built and working)
- Any file in node_modules/

## Key reminders
- technicalindicators is already installed. Use it for ALL indicator math.
- csv-parse is the CSV library, not papaparse. Syntax is different.
- stock-nse-india handles NSE cookies/headers — no need for puppeteer
  for data that stock-nse-india covers.
- Supabase service key = writes (backend only). Anon key = reads (frontend OK).
- No TypeScript. No .ts files. No tsconfig. This is a JavaScript project.

## How to work with me
- Read the PRD section referenced in my task before coding.
- Summarise what you understood before writing code.
- Implement ONLY the current phase. Stub forward dependencies with
  throw new Error('TODO: phase N'), not silent pass-throughs.
- Show file paths you changed relative to repo root; don't paraphrase.
- Never install a new dependency without asking first.
