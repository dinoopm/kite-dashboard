# Kite Analytics — Prompting Playbook v2.0

Updated to reflect the actual project stack: JavaScript (not TypeScript), CommonJS backend, React 19 + Vite 8 frontend, Supabase database, Kite via MCP SDK.

---

## 0. The always-on project memory file (CLAUDE.md)

Place this at the repo root. Every AI session loads it automatically.

```markdown
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
```

---

## 1. Session kickoff prompt

Start every coding session with this:

```
Read CLAUDE.md and PRD_Sector_DeepDive.md before we start.

Summarise in 5 bullet points:
- What Kite Analytics is and what Kite integration we use
- What packages handle technical indicators (don't reimplement)
- What phase we are currently in
- What files exist vs what still needs to be built
- What I must never touch

Do not write any code. Wait for my task.
```

If the summary says "kiteconnect npm" or "TypeScript" or "papaparse", correct it before moving on. Those are the three most common AI drift patterns for this project.

---

## 2. Task prompt template

```
PHASE: <0-4>
PRD SECTION: §<number>
SCOPE: <one sentence>

MUST NOT TOUCH: <files>

EXIT CRITERIA:
- <testable criterion 1>
- <testable criterion 2>
- <testable criterion 3>

Before writing code, summarise what you will build and list
exact files you will create or modify.
```

---

## 3. Phase-specific prompts

### Phase 0 — Foundations

```
PHASE: 0
PRD SECTION: §9, §13
SCOPE: Build kiteClient.js — the MCP wrapper with bottleneck rate limiting.
This is the single file all other backend code uses to call Kite.

TECH REQUIREMENTS:
- CommonJS: use require(), not import
- Use @modelcontextprotocol/sdk (already installed) as the MCP transport
- Rate limiter: bottleneck (install if not present)
- Two separate limiters:
    historical: minTime: 350ms, maxConcurrent: 1  (3 req/s)
    quotes:     minTime: 1100ms, maxConcurrent: 1  (1 req/s)
- On 429 response: exponential backoff, max 3 retries, log with pino
- Methods to expose:
    getHistoricalData(token, interval, from, to, opts)
    getQuotes(instruments[])   // auto-batches to 500 per call
    getOhlc(instruments[])
    getLtp(instruments[])
    getHoldings()
    getInstruments(exchange)
- All methods return Promises. No callbacks.

MUST NOT TOUCH:
- Any frontend files
- Any existing scraper files
- server.js

EXIT CRITERIA:
- File at backend/kiteClient.js
- getQuotes() correctly splits 1200 instruments into 3 calls of 400 each
- 429 response triggers retry with backoff (verify by mocking response)
- Rate limiter blocks 4th historical call in same second
- pino logger used for all errors and retries
- node kiteClient.js runs without errors (smoke test)

Before coding: confirm which MCP transport class from @modelcontextprotocol/sdk
is the right one to use for https://mcp.kite.trade/mcp. Show me the import
and the connection code before writing the full file.
```

```
PHASE: 0
PRD SECTION: §9 data sources
SCOPE: Build tradingCalendar.js — getPrevTradingDay(date) utility.

REQUIREMENTS:
- CommonJS module
- Uses nse-js getNseHolidays() to get the year's holiday list
- Caches holidays in memory (fetch once at startup, not per-call)
- getPrevTradingDay(date) returns the previous trading day as a Date object
  Skips: weekends (Sat/Sun) AND NSE holidays
- Also export: isTradingDay(date), getTradingDaysBack(date, n)
- Handles year-boundary correctly (last trading day of year → first of next)

EXIT CRITERIA:
- getPrevTradingDay(new Date('2026-04-14')) → '2026-04-11' (April 14 = Dr Ambedkar Jayanti holiday)
- getPrevTradingDay(new Date('2026-04-07')) → '2026-04-03' (skips weekend)
- isTradingDay(new Date('2026-04-13')) → false (Gudi Padwa holiday)
- getTradingDaysBack(today, 5) → array of 5 previous trading dates
- All three functions handle null/undefined date gracefully (throw TypeError)
```



### Phase 1 — Filter calculations

```
PHASE: 1
PRD SECTION: §5 Filter 2 (Stage)
SCOPE: Build compute/f2Stage.js — Stage score using technicalindicators.

CRITICAL: technicalindicators is already installed. Use it.
Never implement EMA, RSI, or VWAP from scratch.

CORRECT IMPORT PATTERN:
const { EMA, RSI, VWAP } = require('technicalindicators')

INPUT INTERFACE (document this exactly in a JSDoc comment):
  computeStageScore(candles) → number | null
  candles: Array<{ date, open, high, low, close, volume }>
  Minimum required: 210 candles (for 200-period EMA)
  Returns: 0-100 integer or null if insufficient data

STAGE LOGIC (from PRD §5 Filter 2 — do not improvise):
  Stage 2 early: above 200EMA, EMA rising, RSI 55-65, VWAP dev < 8%  → 90
  Stage 2 mid:   above 200EMA, EMA rising, RSI 60-70, VWAP dev 5-10% → 80
  Stage 2 late:  above 200EMA, RSI 68-75, VWAP dev 8-12%             → 60
  Stage 1 base:  near/below 200EMA, flat slope                        → 60
  Stage 3 early: RSI > 72, VWAP dev > 12%                             → 30
  Stage 3 mid:   RSI > 75, price near 52W high                        → 20
  Stage 4:       below 200EMA, EMA falling                            → 10

MUST NOT TOUCH:
- kiteClient.js
- Any frontend file
- Any other compute file

EXIT CRITERIA:
- Returns null when given fewer than 210 candles
- Returns null when candles array is empty or undefined
- Three hand-computed test cases showing input parameters → expected stage
  (compute by hand first, show your working, wait for my approval before coding)
- Pure function: no I/O, no require('../kiteClient'), no side effects

Before coding: paste the technicalindicators API signature for EMA.calculate()
and VWAP.calculate(). Confirm the input format matches our candle structure.
```

```
PHASE: 1
PRD SECTION: §5 Filter 1 (Leadership)
SCOPE: Build compute/f1Leadership.js — RS-Ratio and RS-Momentum.

No external library needed — pure arithmetic. Pure functions only.

computeRsRatio(stockCandles, indexCandles) → number | null
computeRsMomentum(stockCandles, indexCandles) → number | null
Both return 0-100 scores or null if < 14 days of aligned data.

MUST NOT TOUCH: f2Stage.js, any other file

EXIT CRITERIA:
- Three hand-computed test cases (compute by hand before coding)
- Pure functions, no I/O
- Handles misaligned date arrays (some trading days one stock didn't trade)
- Returns null on divide-by-zero

Before coding: state the mathematical formula for JdK RS-Ratio in your own words,
then generate test case A by hand (show each arithmetic step).
Wait for approval before implementing.
```

### Phase 1 — Snapshot and API

```
PHASE: 1
PRD SECTION: §9 architecture
SCOPE: Build snapshot.js — sector snapshot builder that writes to Supabase.

This is the core compute pipeline. It reads candle data from Kite MCP,
runs f1Leadership and f2Stage on each constituent, and writes the result
to Supabase as a JSON snapshot.

INPUT: sectorSlug (e.g. 'nifty-energy')
OUTPUT: Writes to Supabase table sector_snapshots (create this table):
  id, slug, computed_at, snapshot_json (JSONB), status

PROCESS:
1. Get sector constituents from sectorConstituents.js
2. For each constituent: call kiteClient.getHistoricalData() for 250 days
3. Run f1Leadership and f2Stage
4. Check surveillanceCache.isUnderSurveillance()
5. Compute composite score (see PRD §5 composite formula)
6. Compute dispersion (average pairwise correlation)
7. Compute breadth metrics
8. Write snapshot_json to Supabase

MUST NOT TOUCH:
- f1Leadership.js (already tested)
- f2Stage.js (already tested)
- kiteClient.js

EXIT CRITERIA:
- Runs for 'nifty-energy' without throwing
- Supabase row written with correct slug and non-null snapshot_json
- Correctly marks surveillance stocks by querying Supabase /api/surveillance
- If any single stock fails (bad data), logs the error and continues
  (don't abort the whole sector on one bad stock)
- Duration logged in milliseconds via pino

After writing, run: node snapshot.js nifty-energy
Show me the output before I approve.
```

### Phase 1 — Frontend

```
PHASE: 1
PRD SECTION: §7.2 Layout
SCOPE: Build SectorPage.jsx — the page shell and data loading.

REQUIREMENTS:
- React 19 functional component, .jsx not .tsx
- Route: /sector/:slug (from react-router-dom v7 useParams)
- Data: useQuery from @tanstack/react-query, hitting GET /api/sectors/:slug
  staleTime: 60_000 (1 minute — snapshots don't change per-second)
  retry: 2
- Loading state: skeleton cards (not a spinner — match existing app pattern)
- Error state: "Sector data unavailable — try again" with retry button
- zustand: when page mounts, setSelectedSector(slug) on the sectorStore
- Layout: breadcrumb → SectorHeader → stats strip → main grid → picks → table → detail panel

MUST NOT TOUCH:
- frontend/src/pages/indices/ (entry point — only add a <Link> to it)
- Any existing component
- backend/ (read-only from this task)

EXIT CRITERIA:
- /sector/nifty-energy renders without errors when backend is running
- Loading skeleton visible during fetch
- Error state renders when backend returns 500
- Browser back button works correctly (react-router-dom history)
- zustand store updated on mount (verify with React DevTools)

Do not build sub-components yet. Use placeholder divs with labels
('BreadthCard goes here') for everything except the page shell itself.
```

```
PHASE: 1
PRD SECTION: §7.4 Leader/Laggard quadrant
SCOPE: Build LeaderLaggardQuadrant.jsx using recharts ScatterChart.

PROPS:
  stocks: Array<{
    symbol: string,
    rsScore: number,        // 0-100, F1 output
    stageScore: number,     // 0-100, F2 output
    verdict: 'core_buy' | 'extended' | 'rebasing' | 'avoid',
    surveillanceFlag: boolean
  }>
  onStockClick: (symbol) => void

VISUAL REQUIREMENTS:
- recharts ScatterChart, 580×400px SVG (use width="100%" + aspect ratio)
- X axis: rsScore (0-100), label "RS vs sector →"
- Y axis: stageScore (0-100), label "← Stage (early=top, late=bottom)"
- Four quadrant background colours via recharts ReferenceArea:
    top-right (rs>50, stage>50):  rgba(34,211,160,0.08)  — Core Buys (green)
    bottom-right (rs>50, stage<50): rgba(100,116,139,0.08) — Extended (gray)
    top-left (rs<50, stage>50):   rgba(251,191,36,0.08)  — Rebasing (amber)
    bottom-left (rs<50, stage<50): rgba(248,113,113,0.08) — Avoid (red)
- Quadrant labels as recharts ReferenceLine labels
- Dots coloured by verdict:
    core_buy → #22d3a0, extended → #64748b, rebasing → #fbbf24, avoid → #f87171
- Surveillance stocks: red dot outline (stroke: #f87171, strokeWidth: 2)
- Dot click: calls onStockClick(symbol) and updates zustand selectedStock
- Tooltip on hover: symbol, rsScore, stageScore, verdict
- Aesthetic matches CLAUDE.md exactly

MUST NOT TOUCH:
- Any other chart component
- Backend
- SectorPage.jsx (except the one line that renders this component)

EXIT CRITERIA:
- Renders correctly with 0 stocks (shows quadrant labels only, no errors)
- Renders correctly with 19 stocks spread across all quadrants
- Click fires onStockClick with correct symbol
- Surveillance stocks visually distinguishable (red outline)
- Dark background (use fill="transparent" for chart background)
- Screenshot or Storybook story showing both states

Compare your output visually to the design screenshot before calling it done.
```

---

## 4. Verification prompts

### After any backend compute function

```
Verify this against the checklist:

1. Is it a pure function? (no require('../kiteClient'), no Supabase, no I/O)
2. Does it use technicalindicators for ALL indicator math? (no manual EMA/RSI loops)
3. Does it return null for insufficient data, not 0 or throw?
4. Does it use csv-parse syntax (not papaparse) for any CSV?
5. Is it CommonJS? (module.exports, not export default)
6. Three test cases computed by hand — do the numbers match the code output?

List any failures. Fix them before showing me the code.
```

### After any NSE data fetch

```
Before using stock-nse-india for this data, verify:

1. Open Chrome DevTools on the NSE page that shows this data.
   Check the Network tab for the XHR/fetch request that loads it.
   Can getDataByEndpoint() reach it directly?

2. If yes: use getDataByEndpoint(), not puppeteer.
3. If no: is there a dedicated method in stock-nse-india for this?
4. If no: is there a method in nse-js for this?
5. Only if all above fail: use puppeteer.

State which path you are taking and why before writing any code.
```

### After any frontend component

```
Check the component against this list:

1. Does it use useQuery() for ALL server data? (no bare useEffect + fetch)
2. Does it import clsx for classNames? (no template literals for conditional classes)
3. Does it update zustand store when appropriate?
4. Does it use date-fns for ALL date formatting? (no new Date().toLocaleDateString())
5. Are all colours from the CLAUDE.md palette? (spot check 3 random hex values)
6. Is it a .jsx file not .tsx? (no TypeScript annotations)
7. Does it handle loading and error states?

Any failure = fix before review.
```

---

## 5. The `technicalindicators` cheat sheet

This package is already installed. Always use it. Common patterns:

```js
const { EMA, RSI, VWAP, MFI, BollingerBands } = require('technicalindicators')

// EMA-200 (needs 200+ data points)
const ema = EMA.calculate({ period: 200, values: candles.map(c => c.close) })
// Returns array — last element is today's EMA

// RSI-14
const rsi = RSI.calculate({ period: 14, values: candles.map(c => c.close) })

// VWAP (resets daily — pass only today's candles for intraday,
// or a rolling 20-day window for swing VWAP)
const vwap = VWAP.calculate({
  high:   candles.map(c => c.high),
  low:    candles.map(c => c.low),
  close:  candles.map(c => c.close),
  volume: candles.map(c => c.volume)
})

// MFI-14
const mfi = MFI.calculate({
  period: 14,
  high:   candles.map(c => c.high),
  low:    candles.map(c => c.low),
  close:  candles.map(c => c.close),
  volume: candles.map(c => c.volume)
})
```

**Common mistake:** AI often tries to implement EMA as `prices.reduce(...)`. Stop it immediately. The `technicalindicators` package is there and tested.

---

## 6. The `csv-parse` cheat sheet

The project uses `csv-parse`, not `papaparse`. The syntax is different:

```js
const { parse } = require('csv-parse')
const { createReadStream } = require('fs')

// Streaming (large files — bhavcopy)
createReadStream(filePath)
  .pipe(parse({ columns: true, trim: true, skip_empty_lines: true }))
  .on('data', row => { /* row is an object keyed by column header */ })
  .on('end', () => console.log('done'))
  .on('error', err => console.error(err))

// Sync / callback (small files — surveillance, ~50 rows)
parse(csvString, { columns: true, trim: true }, (err, records) => {
  if (err) throw err
  // records is array of objects
})
```

**Common mistake:** AI uses `Papa.parse()`. That's papaparse. This project has `csv-parse`. The above is correct.

---

## 7. Supabase patterns for this project

```js
// backend/supabase.js — two clients, one file
const { createClient } = require('@supabase/supabase-js')

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY   // bypasses RLS — backend writes only
)

const supabasePublic = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY      // RLS-protected — safe for frontend
)

module.exports = { supabaseAdmin, supabasePublic }

// ── Write pattern (backend only, always supabaseAdmin) ──
const { error } = await supabaseAdmin
  .from('participant_oi')
  .upsert(rows, { onConflict: 'date,participant' })
if (error) throw new Error(`Supabase upsert failed: ${error.message}`)

// ── Read pattern (frontend, always supabasePublic via React Query) ──
const { data, error } = useQuery({
  queryKey: ['participant-oi', date],
  queryFn: async () => {
    const { data, error } = await supabase
      .from('participant_oi')
      .select('*')
      .eq('date', date)
      .order('participant')
    if (error) throw error
    return data
  },
  staleTime: 5 * 60 * 1000
})
```

---

## 8. Debug prompts

```
BUG REPORT

Expected: <precise expected behaviour>
Observed: <precise actual behaviour>
Relevant logs: <paste — do not summarise>
Affected file: <path>

Without changing any code:
1. List the 3 most likely root causes in order of probability
2. For each, state what evidence would confirm or rule it out
3. Wait for me to choose which to investigate before touching the code
```

---

## 9. Scope-drift rescue prompt

```
STOP.

You modified <file>. That file is in MUST NOT TOUCH.
Revert it exactly. Show me git diff after reverting.

List every file changed in this turn:
- Files I asked you to change:
- Files you changed anyway:

Do not commit anything until I approve the scope.
```

---

## 10. CommonJS / ESM confusion rescue prompt

Use this if the AI writes `import` statements or `export default` in backend files:

```
STOP. The backend is CommonJS ("type": "commonjs" in package.json).
Use require() not import. Use module.exports not export default.
Rewrite the file using CommonJS syntax.

Correct pattern:
  const x = require('x')
  const { fn } = require('./utils')
  module.exports = { myFunction }
  module.exports = myFunction   // for single export

Wrong (do not use in backend):
  import x from 'x'
  export default myFunction
  export const myFunction = ...
```

---

## 11. TypeScript rescue prompt

Use this if the AI adds type annotations, `.ts` files, or tsconfig:

```
STOP. This project is JavaScript. Do not add TypeScript.
No .ts or .tsx files. No tsconfig.json. No type annotations.
No "as SomeType" casts. No interface or type declarations.

Delete any .ts files you created. Rewrite as plain .js / .jsx.
JSDoc comments are allowed for documentation but they are optional.
```

---

## 12. Phase-to-failure-mode mapping

| Phase | Most common AI failure | Rescue prompt to use |
|---|---|---|
| 0 | Writes TypeScript; uses import instead of require | §11 TypeScript rescue, §10 CommonJS rescue |
| 0 | Reimplements rate limiter from scratch instead of using bottleneck | Verification prompt §4 |
| 1 (data) | Reimplements EMA/RSI manually instead of `technicalindicators` | technicalindicators cheat sheet §5 |
| 1 (data) | Uses papaparse syntax instead of csv-parse | csv-parse cheat sheet §6 |
| 1 (UI) | Uses bare useEffect+fetch instead of useQuery | Frontend verification §4 |
| 2 | Confuses short covering (bullish) with short buildup (bearish) | Run domain check prompt first |
| 3 | Uses puppeteer for data stock-nse-india already covers | NSE data verification §4 |
| 4 | Touches existing shipped pages during "cleanup" | Scope-drift rescue §9 |
| All | Writes ESM in backend | CommonJS rescue §10 |
| All | Adds TypeScript | TypeScript rescue §11 |

---

## 13. Reset prompt

Use when a session has produced contradictory or confused code:

```
This session has drifted. Reset.

Ignore our previous conversation. Re-read CLAUDE.md.

State back:
1. What language is the backend? (expected: JavaScript, CommonJS)
2. What package handles RSI/EMA/VWAP calculations? (expected: technicalindicators)
3. What package handles Kite Connect? (expected: @modelcontextprotocol/sdk)
4. What is the database? (expected: Supabase)
5. What phase are we in and what is the next single task?

Do not write code until I confirm this matches my understanding.
```
