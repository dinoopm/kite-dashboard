# US Quant Stock Picks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic five-factor ranking over S&P 500 ∪ Nasdaq 100, recorded daily to `us_pick_snapshots`, scored against SPY, backtested over 2015→today for its four price factors, and shown on a `/us/stock-picks` page with track-record badges.

**Architecture:** Pure factor maths in `backend/usPicks/factors.js` operates on adjusted daily bars; `engine.js` loads inputs (bars via the multi-symbol Alpaca endpoint, membership, earnings dates, EPS revisions, macro label) and turns them into raw factor rows plus regime and exclusions. Ranking is percentile × weights on both server (recorded series) and client (sliders). Scorecard and backtest share the same factor functions so they cannot measure different rules. A dedicated Express router mounts at `/api/us/stock-picks`.

**Tech Stack:** Node ≥ 22, Express 5, `node:test`, Supabase JS (manual DDL), Alpaca data API v2, `yahoo-finance2`, React 18 + Vite, `react-markdown`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-03-us-quant-picks-design.md`. Every number below is copied from it.
- Universe: `getSP500() ∪ getNasdaq100()`, deduplicated on symbol.
- Factors: `momentumRaw = close[t−5]/close[t−25] − 1`; `volumeRaw = max(0, surge) × authenticity`, `surge = mean(vol[t−4..t]) / mean(vol[t−19..t−5]) − 1`, `authenticity = 0.6·corroboration + 0.4·persistence`, `corroboration = clamp01(|ret5%| / (0.5 + surge%/200))`, `persistence` = share of last 5 sessions with volume > 1.5× baseline; `fiftyTwoRaw = newHigh5 − newLow5 + (close/high252 − 0.8)`; `relStrengthRaw = (close/close[t−63] − 1) − (SPY/SPY[t−63] − 1)` in percentage points; `revisionsRaw = 0.5·(up−down)/(up+down) + 0.5·clamp(trendNow/trend30dAgo − 1, −0.2, 0.2)/0.2`, null → neutral (percentile 50).
- `trapRisk = surge > 1.0 && authenticity < 0.45`.
- Default weights: momentum 30, volume 20, fiftyTwo 15, relStrength 20, revisions 15. Backtest weights: same with revisions 0.
- Exclusions: median 20-session dollar volume < $10M; earnings within next 5 sessions; red-severity flag (`pump-fade`).
- Regime: % above 50D SMA, % above 200D SMA, % positive momentum; label `risk-on` if both SMA readings > 60%, `risk-off` if both < 40%, else `mixed`; macro label from latest `macro_signal_snapshots.regime` appended.
- Snapshot: default-weight top 25, traps excluded, `snap_date` = last SPY bar date.
- Scoring horizons 5/10/22 bars, excess over SPY, MIN_N 20 ("too few to judge").
- Backtest: from 2015-01-01, every 5th SPY session, top 25 and top 10, vs universe median and vs SPY, quintiles, Spearman IC with t-stat, momentum sweep `{20/5, 60/5, 120/20, 252/21}`.
- Supabase DDL is manual: migration scripts print SQL and verify reachability.
- Tests use `node:test` + `node:assert/strict`. Backend: `cd backend && node --test <file>`. Frontend: `cd frontend && npm test`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Match the repo's style: dense *why* comments, plain functions, no abstractions for their own sake. The LLM only narrates.

---

## File map

| file | responsibility |
|---|---|
| `backend/alpacaData.js` (new) | `alpacaGet`, `sanitizeBar`, `fetchBarsMulti`, `isConfigured` — lifted out of `alpaca.js` so modules that are *not* the router can fetch bars without a circular require |
| `backend/usRedFlags.js` (new) | `barFlags(bars)` — the five bar-based red-flag checks, lifted out of the `/red-flags/:symbol` route |
| `backend/alpaca.js` (modify) | imports the two modules above; exports `getEarningsCalendar()` |
| `backend/usPicks/factors.js` (new) | pure per-symbol factor maths, breadth |
| `backend/usPicks/revisions.js` (new) | `revisionsRawFrom(earningsTrend)` pure; `fetchRevisions(symbols)` cached |
| `backend/usPicks/engine.js` (new) | `loadInputs`, `buildUniverseFrom`, `buildUsFactorUniverse`, `rankUniverse`, `DEFAULT_WEIGHTS`, `saveDailySnapshot`, `fetchSnapshotHistory` |
| `backend/usPicks/summary.js` (new) | Groq narration of ranked rows |
| `backend/signals/usMarketSeries.js` (new) | SPY calendar + closes + benchmark for the US scorer |
| `backend/usPicks/scorecard.js` (new) | recorded rows scored vs SPY, badge-shaped output |
| `backend/usPicks/backtest.js` (new) | weekly re-evaluation 2015→today |
| `backend/usPicks/routes.js` (new) | Express router for `/api/us/stock-picks/*` |
| `backend/migrate_us_pick_snapshots.js` (new) | DDL printer + verifier |
| `backend/dailyJobs.js` (modify) | US snapshot step |
| `backend/signals/registry.js` (modify) | `us_picks_top25`, `us_picks_top10` |
| `backend/signals/scorecard.js` (modify) | skip `market: 'US'`; `headline` takes `benchmarkLabel` |
| `backend/server.js` (modify) | mount router |
| `frontend/src/lib/picksRank.js` (new) | `percentileRanks`, `rankRows` shared by both pages |
| `frontend/src/lib/useSignalScore.js` (modify) | `market` option |
| `frontend/src/components/SignalScore.jsx` (modify) | `market="US"` uses the US scorecard |
| `frontend/src/pages/marketData/StockPicks.jsx` (modify) | import `percentileRanks` |
| `frontend/src/pages/us/UsStockPicks.jsx` (new) | the page |
| `frontend/src/App.jsx`, `frontend/src/components/Navbar.jsx` (modify) | route + nav |

---

### Task 1: Lift Alpaca bar fetching out of the router

**Files:**
- Create: `backend/alpacaData.js`
- Create: `backend/alpacaData.test.js`
- Modify: `backend/alpaca.js:36-127` (constants, cache, `alpacaGet`), `backend/alpaca.js:328-333` (`sanitizeBar`), `backend/alpaca.js:2175-2195` (`fetchBarsMulti`)

**Interfaces:**
- Produces: `alpacaGet(path, params, ttlMs)`, `sanitizeBar(bar)`, `fetchBarsMulti(symbols, start, { get = alpacaGet } = {}) → { [symbol]: bar[] }` where `bar = { date: ISO string, open, high, low, close, volume }`, `isConfigured()`, `FEED`, `DATA_BASE`, `API_KEY`, `API_SECRET`.

- [ ] **Step 1: Write the failing test**

```js
// backend/alpacaData.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { fetchBarsMulti, sanitizeBar } = require('./alpacaData');

describe('fetchBarsMulti', () => {
  test('asks for at most 100 symbols per call and merges the pages', async () => {
    const calls = [];
    const get = async (path, params) => {
      calls.push(params.symbols.split(','));
      // second chunk paginates once
      if (params.symbols.startsWith('S100') && !params.page_token) {
        return { bars: { S100: [{ t: '2025-01-02T05:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] }, next_page_token: 'p2' };
      }
      const out = {};
      for (const s of params.symbols.split(',')) out[s] = [{ t: '2025-01-03T05:00:00Z', o: 1, h: 2, l: 0.5, c: 1.6, v: 11 }];
      return { bars: out, next_page_token: null };
    };
    const symbols = Array.from({ length: 150 }, (_, i) => `S${i}`);
    const bars = await fetchBarsMulti(symbols, new Date('2025-01-01'), { get });
    assert.equal(calls[0].length, 100);
    assert.equal(calls[1].length, 50);
    assert.equal(Object.keys(bars).length, 150);
    assert.equal(bars.S100.length, 2, 'both pages of the paginated chunk are kept');
    assert.equal(bars.S0[0].close, 1.6);
  });
});

describe('sanitizeBar', () => {
  test('clamps an absurd wick to the body', () => {
    const b = sanitizeBar({ open: 10, high: 50, low: 9, close: 11, volume: 1 });
    assert.equal(b.high, 11);
    assert.equal(b.low, 9);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && node --test alpacaData.test.js`
Expected: FAIL — `Cannot find module './alpacaData'`

- [ ] **Step 3: Create `backend/alpacaData.js`**

Move the code verbatim from `alpaca.js`, adding the `get` injection point on `fetchBarsMulti`:

```js
// ─── Alpaca market-data plumbing shared by the router and the batch engines ──
//
// Lifted out of alpaca.js so a module that is NOT the router — the US picks
// engine, its backtest, its scorer — can fetch bars without requiring the
// 2,600-line router (and, since the router will mount routes that require
// those modules, without a circular require). Nothing here knows about
// Express.

const DATA_BASE = 'https://data.alpaca.markets/v2';
const FEED = process.env.ALPACA_DATA_FEED || 'sip';
const API_KEY = process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID;
const API_SECRET = process.env.ALPACA_API_SECRET || process.env.APCA_API_SECRET_KEY;
const isConfigured = () => Boolean(API_KEY && API_SECRET);

// ─── Tiny in-memory cache (keyed by request URL) ───────────────────────────
const cache = {};    // url -> { data, ts }
const inflight = {}; // url -> Promise (coalesce concurrent identical fetches)

async function alpacaGet(path, params = {}, ttlMs = 60_000) {
  if (!isConfigured()) {
    const err = new Error('Alpaca API keys are not configured');
    err.statusCode = 503;
    err.notConfigured = true;
    throw err;
  }
  const qs = new URLSearchParams({ ...params, feed: params.feed || FEED }).toString();
  const url = `${DATA_BASE}${path}${qs ? `?${qs}` : ''}`;

  const hit = cache[url];
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  if (inflight[url]) return inflight[url];

  inflight[url] = (async () => {
    const resp = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID': API_KEY,
        'APCA-API-SECRET-KEY': API_SECRET,
        'Accept': 'application/json',
      },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      const err = new Error(`Alpaca ${resp.status}: ${body.slice(0, 300)}`);
      err.statusCode = resp.status === 429 ? 429 : 502;
      throw err;
    }
    const data = await resp.json();
    cache[url] = { data, ts: Date.now() };
    return data;
  })().finally(() => { delete inflight[url]; });

  return inflight[url];
}

// Bars with an absurd wick (a bad print) get the wick clamped to the body.
const sanitizeBar = (b) => {
  const bodyLo = Math.min(b.open, b.close), bodyHi = Math.max(b.open, b.close);
  const low = (b.low <= 0 || b.low < bodyLo * 0.5) ? bodyLo : b.low;
  const high = b.high > bodyHi * 2 ? bodyHi : b.high;
  return (low === b.low && high === b.high) ? b : { ...b, low, high };
};

// Daily bars for many symbols via Alpaca's multi-symbol endpoint — one request
// per 100 symbols, paginated. `get` is injectable only so the chunking and the
// pagination can be tested without the network.
async function fetchBarsMulti(symbols, start, { get = alpacaGet } = {}) {
  const out = {}; // symbol -> candles[]
  const CHUNK = 100;
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    let pageToken = null, guard = 0;
    do {
      const params = { symbols: chunk.join(','), timeframe: '1Day', start: start.toISOString(), limit: 10000, adjustment: 'all' };
      if (pageToken) params.page_token = pageToken;
      const data = await get('/stocks/bars', params, 60 * 60 * 1000);
      const bars = data?.bars || {};
      for (const s of Object.keys(bars)) {
        (out[s] = out[s] || []).push(...bars[s].map(b => sanitizeBar({ date: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })));
      }
      pageToken = data?.next_page_token || null;
    } while (pageToken && ++guard < 60);
  }
  return out;
}

module.exports = { alpacaGet, sanitizeBar, fetchBarsMulti, isConfigured, FEED, DATA_BASE, API_KEY, API_SECRET };
```

- [ ] **Step 4: Point `alpaca.js` at it**

In `backend/alpaca.js`:
1. Delete the definitions of `DATA_BASE`, `FEED`, `API_KEY`, `API_SECRET`, `isConfigured` (lines ~38–56, keep `TRADING_BASE`, `SNAPSHOT_FEED`, `FEED_PROBE_SYMBOLS`, `feedHealth`).
2. Delete the `cache`/`inflight` objects and the whole `alpacaGet` function (lines ~85–127).
3. Delete `sanitizeBar` (lines ~328–333).
4. Delete `fetchBarsMulti` (lines ~2175–2195) and its leading comment.
5. Near the top, after the `express`/`axios` requires, add:

```js
const { alpacaGet, sanitizeBar, fetchBarsMulti, isConfigured, FEED, DATA_BASE, API_KEY, API_SECRET } = require('./alpacaData');
```

- [ ] **Step 5: Verify the router still loads and existing tests pass**

Run: `cd backend && node -e "require('./alpaca'); console.log('ok')" && node --test alpaca.test.js alpacaData.test.js`
Expected: `ok`, all tests PASS. If `alpaca.test.js` fails on a missing export, the deletion took a name the file still uses — grep for it and re-import.

- [ ] **Step 6: Commit**

```bash
git add backend/alpacaData.js backend/alpacaData.test.js backend/alpaca.js
git commit -m "alpacaData: lift bar fetching out of the router

fetchBarsMulti, alpacaGet and sanitizeBar move to their own module so the
US picks engine can use them without requiring the router.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Lift red-flag bar checks and the earnings calendar into callable functions

**Files:**
- Create: `backend/usRedFlags.js`, `backend/usRedFlags.test.js`
- Modify: `backend/alpaca.js` — `/red-flags/:symbol` route (~line 413) and `/earnings-calendar` route (~line 1354), `module.exports`

**Interfaces:**
- Produces: `barFlags(bars) → [{ id, severity, title, detail }]` (bars = last ≥25 daily bars, oldest first). `getEarningsCalendar() → { events: [{ symbol, name, date, session, estimated, marketCap, mine }], universe, source }` exported from `alpaca.js`.

- [ ] **Step 1: Write the failing test**

```js
// backend/usRedFlags.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { barFlags } = require('./usRedFlags');

const mk = (closes, volumes = null) => closes.map((c, i) => ({
  date: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
  open: c, high: c * 1.01, low: c * 0.99, close: c, volume: volumes ? volumes[i] : 1e6,
}));

describe('barFlags', () => {
  test('flags a pump-and-fade as red', () => {
    const c = [];
    for (let i = 0; i < 20; i++) c.push(10);
    for (let i = 1; i <= 8; i++) c.push(10 + i * 1);     // +80% ramp
    for (let i = 1; i <= 6; i++) c.push(18 - i * 1);     // −33% off the peak
    const flags = barFlags(mk(c));
    assert.ok(flags.some(f => f.id === 'pump-fade' && f.severity === 'red'));
  });

  test('a quiet, liquid, trending stock has no flags', () => {
    const c = Array.from({ length: 40 }, (_, i) => 100 + i * 0.2);
    assert.deepEqual(barFlags(mk(c)), []);
  });

  test('thin liquidity is amber, never red', () => {
    const c = Array.from({ length: 40 }, () => 2);
    const flags = barFlags(mk(c, c.map(() => 1000)));
    const thin = flags.find(f => f.id === 'thin-liquidity');
    assert.ok(thin);
    assert.equal(thin.severity, 'amber');
  });

  test('says nothing on too little history', () => {
    assert.deepEqual(barFlags(mk([1, 2, 3])), []);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && node --test usRedFlags.test.js`
Expected: FAIL — `Cannot find module './usRedFlags'`

- [ ] **Step 3: Create `backend/usRedFlags.js`** with the five bar-based checks moved verbatim from the route:

```js
// ─── US manipulation red flags, from daily bars alone ────────────────────────
//
// The five checks the /api/us/red-flags/:symbol route runs on a stock's last
// 60 bars, as a function, so the picks engine can apply the same rule to every
// name in its universe without looping HTTP back into the server. The route
// keeps the sixth check (volatility spike) because that one reads a year of
// closes, not the 60-bar window.
//
// Severity is the contract: `red` is the only level the picks engine excludes
// on; `amber` is shown, never acted on.

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const r1 = (v) => (v == null || !isFinite(v) ? null : +v.toFixed(1));

function barFlags(barsIn) {
  const bars = (barsIn || []).slice(-60);
  const flags = [];
  if (bars.length < 25) return flags;
  const last20 = bars.slice(-20);

  // 1) Thin liquidity — easiest stock to manipulate is one nobody trades.
  const dollarVol = median(last20.map(b => b.close * b.volume));
  if (dollarVol != null && dollarVol < 1e6) {
    flags.push({
      id: 'thin-liquidity', severity: 'amber',
      title: `Thin liquidity (~$${(dollarVol / 1e6).toFixed(2)}M/day median)`,
      detail: 'Median dollar volume under $1M/day — wide spreads, easy to ramp, hard to exit. Micro-float names are the primary pump-and-dump vehicle in the US.',
    });
  }

  // 2) Pump-and-fade — vertical ramp followed by a break from the peak.
  const win = bars.slice(-30);
  let peakIdx = 0;
  win.forEach((b, i) => { if (b.close > win[peakIdx].close) peakIdx = i; });
  const preIdx = Math.max(0, peakIdx - 10);
  const ramp = win[preIdx].close > 0 ? win[peakIdx].close / win[preIdx].close - 1 : 0;
  const offPeak = win[peakIdx].close > 0 ? 1 - win[win.length - 1].close / win[peakIdx].close : 0;
  if (ramp >= 0.4 && offPeak >= 0.2) {
    flags.push({
      id: 'pump-fade', severity: 'red',
      title: 'Pump-and-fade pattern',
      detail: `Price ran +${r1(ramp * 100)}% into a peak within ~10 sessions, then dropped ${r1(offPeak * 100)}% from it — the footprint of a promoted ramp being distributed.`,
    });
  }

  // 3) Rising price on fading volume (distribution; volume is the best US
  //    proxy — there is no delivery % here).
  const run20 = last20[0].close > 0 ? last20[last20.length - 1].close / last20[0].close - 1 : 0;
  const volRecent = mean(last20.slice(-5).map(b => b.volume));
  const volPrior = mean(last20.slice(0, 15).map(b => b.volume));
  if (run20 >= 0.15 && volPrior > 0 && volRecent < volPrior * 0.65) {
    flags.push({
      id: 'fading-volume', severity: 'amber',
      title: 'Price rising on fading volume',
      detail: `Price +${r1(run20 * 100)}% over ~20 sessions while volume fell ${r1((1 - volRecent / volPrior) * 100)}% — fewer real buyers behind each new high.`,
    });
  }

  // 4) Gap-and-fade days — gapped open sold into all day.
  let gapFades = 0;
  for (let i = bars.length - 15; i < bars.length; i++) {
    const prev = bars[i - 1];
    if (prev && bars[i].open >= prev.close * 1.03 && bars[i].close <= bars[i].open * 0.985) gapFades++;
  }
  if (gapFades >= 3) {
    flags.push({
      id: 'gap-fade', severity: 'amber',
      title: `Repeated gap-and-fade sessions (${gapFades} of last 15)`,
      detail: 'Opens gapped up 3%+ then closed below the open — excitement at the open is being sold into, a common promoted-stock signature.',
    });
  }

  // 5) Volume spikes with no price move — churn/crossing prints.
  const medVol = median(last20.map(b => b.volume));
  let quietSpikes = 0;
  for (let i = bars.length - 10; i < bars.length; i++) {
    const prev = bars[i - 1];
    if (prev && medVol > 0 && bars[i].volume >= 5 * medVol && Math.abs(bars[i].close / prev.close - 1) < 0.015) quietSpikes++;
  }
  if (quietSpikes >= 2) {
    flags.push({
      id: 'quiet-volume-spike', severity: 'amber',
      title: `Volume spikes without price movement (${quietSpikes} day(s))`,
      detail: '5×+ normal volume with the price barely moving — block crossings or churn, not directional buying.',
    });
  }
  return flags;
}

module.exports = { barFlags };
```

- [ ] **Step 4: Make the route use it**

In `backend/alpaca.js`, add `const { barFlags } = require('./usRedFlags');` near the other requires. Replace the body of `router.get('/red-flags/:symbol', …)` from `const bars = all.slice(-60);` through the end of check 5 with:

```js
    const flags = barFlags(all.slice(-60));
    const r1 = (v) => (v == null || !isFinite(v) ? null : +v.toFixed(1));
```

Keep check 6 (`hvSpike`) and the `res.json(...)` exactly as they are.

- [ ] **Step 5: Extract the earnings calendar into a function**

In `backend/alpaca.js`, change the `/earnings-calendar` route so its body lives in a function the picks engine can call:

```js
let earningsCalCache = { data: null, ts: 0 };
const EARNINGS_CAL_TTL = 12 * 60 * 60 * 1000;

/** Upcoming earnings across S&P 500 + Nasdaq 100 + watched symbols, cached 12h. */
async function getEarningsCalendar() {
  if (earningsCalCache.data && Date.now() - earningsCalCache.ts < EARNINGS_CAL_TTL) {
    return { ...earningsCalCache.data, cached: true };
  }
  // <<< the existing try-block body, unchanged, from `const mine = await usWatchedSymbols();`
  //     through `earningsCalCache = { data, ts: Date.now() };` >>>
  return data;
}

router.get('/earnings-calendar', async (req, res) => {
  try {
    res.json(await getEarningsCalendar());
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message });
  }
});
```

Add `getEarningsCalendar` to `module.exports`.

- [ ] **Step 6: Run tests**

Run: `cd backend && node --test usRedFlags.test.js alpaca.test.js && node -e "const a=require('./alpaca'); console.log(typeof a.getEarningsCalendar)"`
Expected: PASS, `function`

- [ ] **Step 7: Commit**

```bash
git add backend/usRedFlags.js backend/usRedFlags.test.js backend/alpaca.js
git commit -m "US red flags and earnings calendar as functions, not only routes

The picks engine needs both on every name in its universe; calling them as
functions avoids an HTTP loop back into the server.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Pure factor maths

**Files:**
- Create: `backend/usPicks/factors.js`, `backend/usPicks/factors.test.js`

**Interfaces:**
- Produces:
  - `momentumAt(closes, i, { window = 20, skip = 5 } = {}) → number|null`
  - `volumeAt(closes, volumes, i) → { surge, surgePct, ret5Abs, corroboration, persistence, authenticity, volumeRaw, trapRisk, trapReason }` (all null/false when unwarm)
  - `fiftyTwoAt(closes, i) → { high252, low252, nearHighPct, newHigh5, newLow5, fiftyTwoRaw }|null`
  - `relStrengthAt(closes, spyCloses, i) → number|null` (percentage points)
  - `dollarVolumeMedianAt(closes, volumes, i) → number|null`
  - `smaAt(values, period, i) → number|null`
  - `factorRowAt({ closes, volumes, spyCloses }, i, { momentum } = {}) → { momentumRaw, ..., aboveSma50, aboveSma200 }`
  - `breadth(rows) → { pctAbove50, pctAbove200, pctPositiveMomentum, label }`
  - constants `MOM_WINDOW=20, MOM_SKIP=5, RS_WINDOW=63, FIFTY_TWO_WINDOW=252, TRAP_SURGE=1.0, TRAP_AUTH=0.45, HEAVY_MULT=1.5`

- [ ] **Step 1: Write the failing tests**

```js
// backend/usPicks/factors.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const F = require('./factors');

const flat = (n, v) => Array.from({ length: n }, () => v);
const ramp = (n, from, step) => Array.from({ length: n }, (_, i) => from + i * step);

describe('momentumAt', () => {
  test('is the 20-session return ending 5 sessions ago', () => {
    const closes = ramp(40, 100, 1); // close[i] = 100 + i
    const i = 39;
    // close[34] / close[14] - 1 = 134/114 - 1
    assert.ok(Math.abs(F.momentumAt(closes, i) - (134 / 114 - 1)) < 1e-12);
  });
  test('is null before the window is warm', () => {
    assert.equal(F.momentumAt(ramp(20, 100, 1), 19), null);
  });
  test('accepts a different window for the backtest sweep', () => {
    const closes = ramp(100, 100, 1);
    assert.ok(Math.abs(F.momentumAt(closes, 99, { window: 60, skip: 5 }) - (194 / 134 - 1)) < 1e-12);
  });
});

describe('volumeAt', () => {
  test('a heavy up week with a price move is authentic', () => {
    const closes = [...flat(20, 100), 102, 104, 106, 108, 110];
    const volumes = [...flat(20, 1000), 3000, 3000, 3000, 3000, 3000];
    const v = F.volumeAt(closes, volumes, 24);
    assert.ok(Math.abs(v.surge - 2) < 1e-9, 'volume tripled');
    assert.equal(v.persistence, 1);
    assert.ok(v.authenticity > 0.6);
    assert.equal(v.trapRisk, false);
    assert.ok(v.volumeRaw > 0);
  });
  test('a heavy week with a flat price is a trap', () => {
    const closes = [...flat(20, 100), 100.1, 100, 100.2, 100.1, 100];
    const volumes = [...flat(20, 1000), 4000, 4000, 4000, 4000, 4000];
    const v = F.volumeAt(closes, volumes, 24);
    assert.equal(v.trapRisk, true);
    assert.match(v.trapReason, /flat/);
  });
  test('no surge means no trap and zero raw', () => {
    const v = F.volumeAt(flat(30, 100), flat(30, 1000), 29);
    assert.equal(v.trapRisk, false);
    assert.equal(v.volumeRaw, 0);
  });
  test('is unwarm before 20 sessions', () => {
    assert.equal(F.volumeAt(flat(10, 1), flat(10, 1), 9).surge, null);
  });
});

describe('fiftyTwoAt', () => {
  test('a fresh 252-session high scores +1 plus proximity', () => {
    const closes = [...flat(260, 100), 101, 102, 103, 104, 105];
    const f = F.fiftyTwoAt(closes, closes.length - 1);
    assert.equal(f.newHigh5, true);
    assert.equal(f.newLow5, false);
    assert.ok(Math.abs(f.fiftyTwoRaw - (1 + (1 - 0.8))) < 1e-9);
  });
  test('a fresh low scores −1', () => {
    const closes = [...flat(260, 100), 99, 98, 97, 96, 95];
    const f = F.fiftyTwoAt(closes, closes.length - 1);
    assert.equal(f.newLow5, true);
    assert.ok(f.fiftyTwoRaw < 0);
  });
  test('null before 252 sessions', () => {
    assert.equal(F.fiftyTwoAt(flat(100, 1), 99), null);
  });
});

describe('relStrengthAt', () => {
  test('is the stock return minus the SPY return, in points', () => {
    const closes = [...flat(63, 100), 110];
    const spy = [...flat(63, 400), 420];
    assert.ok(Math.abs(F.relStrengthAt(closes, spy, 63) - (10 - 5)) < 1e-9);
  });
  test('null when either leg is unwarm', () => {
    assert.equal(F.relStrengthAt(flat(10, 1), flat(10, 1), 9), null);
  });
});

describe('breadth', () => {
  test('labels by both SMA readings', () => {
    const on = Array.from({ length: 10 }, () => ({ aboveSma50: true, aboveSma200: true, momentumRaw: 0.1 }));
    assert.equal(F.breadth(on).label, 'risk-on');
    const off = on.map(() => ({ aboveSma50: false, aboveSma200: false, momentumRaw: -0.1 }));
    assert.equal(F.breadth(off).label, 'risk-off');
    const mixed = [...on.slice(0, 5), ...off.slice(0, 5)];
    assert.equal(F.breadth(mixed).label, 'mixed');
    assert.equal(F.breadth(mixed).pctAbove50, 50);
  });
});

describe('factorRowAt', () => {
  test('carries every factor and the SMA flags', () => {
    const closes = ramp(300, 100, 0.1);
    const volumes = flat(300, 1e6);
    const spy = ramp(300, 400, 0.1);
    const row = F.factorRowAt({ closes, volumes, spyCloses: spy }, 299);
    for (const k of ['momentumRaw', 'volumeRaw', 'fiftyTwoRaw', 'relStrengthRaw']) assert.equal(typeof row[k], 'number', k);
    assert.equal(row.aboveSma50, true);
    assert.equal(row.aboveSma200, true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test usPicks/factors.test.js`
Expected: FAIL — `Cannot find module './factors'`

- [ ] **Step 3: Implement `backend/usPicks/factors.js`**

```js
// ─── US Quant Picks — the factor maths, and nothing else ─────────────────────
//
// Every function here reads arrays and an index i, and only ever looks at
// indices ≤ i. That single property is what makes the backtest honest: running
// these at a past i reproduces exactly what the live engine would have said on
// that evening. No fetching, no dates, no Supabase — the engine supplies
// aligned arrays and asks.
//
// The definitions mirror backend/picks/engine.js (India) where the data allows
// it, so the two pages rank on the same idea of momentum, volume and 52-week
// strength. Where India has a term this market cannot supply — delivery % in
// the volume authenticity — it is simply absent, and the weights of the
// remaining terms are renormalised rather than a zero silently dragging every
// stock's authenticity down.

const MOM_WINDOW = 20;          // sessions in the momentum return
const MOM_SKIP = 5;             // freshest sessions skipped (short-term reversal)
const RS_WINDOW = 63;           // ~3 months, deliberately longer than momentum
const FIFTY_TWO_WINDOW = 252;   // sessions in "52-week"
const VOL_RECENT = 5;           // the week being judged
const VOL_BASE = 15;            // baseline sessions before it (6..20)
const HEAVY_MULT = 1.5;         // a session counts as heavy above this × baseline
const TRAP_SURGE = 1.0;         // volume more than doubled...
const TRAP_AUTH = 0.45;         // ...with little to show for it

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Simple moving average of `values` over `period` ending at i, or null. */
function smaAt(values, period, i) {
  if (i < period - 1) return null;
  let s = 0;
  for (let k = i - period + 1; k <= i; k++) s += values[k];
  return s / period;
}

/** close[i−skip] / close[i−skip−window] − 1. */
function momentumAt(closes, i, { window = MOM_WINDOW, skip = MOM_SKIP } = {}) {
  const a = i - skip, b = i - skip - window;
  if (b < 0) return null;
  const c0 = closes[b], c1 = closes[a];
  if (!(c0 > 0) || c1 == null) return null;
  return c1 / c0 - 1;
}

/**
 * Volume conviction for the week ending at i, judged against the stock's own
 * baseline (sessions i−19..i−5), with the authenticity guard from India minus
 * its delivery term. A volume surge that moved price and persisted is demand;
 * one that did neither is churn, and its raw strength is scaled down to match.
 */
function volumeAt(closes, volumes, i) {
  const none = { surge: null, surgePct: null, ret5Abs: null, corroboration: null, persistence: null, authenticity: null, volumeRaw: 0, trapRisk: false, trapReason: null };
  if (i < VOL_RECENT + VOL_BASE - 1) return none;
  const recent = volumes.slice(i - VOL_RECENT + 1, i + 1);
  const base = volumes.slice(i - VOL_RECENT - VOL_BASE + 1, i - VOL_RECENT + 1);
  const baseAvg = mean(base);
  if (!(baseAvg > 0)) return none;
  const surge = mean(recent) / baseAvg - 1;
  const surgePct = surge * 100;
  const cSkip = closes[i - VOL_RECENT];
  const ret5Abs = cSkip > 0 ? Math.abs(closes[i] / cSkip - 1) * 100 : 0;
  // (a) price corroboration: a real volume surge moves price.
  const corroboration = clamp01(ret5Abs / (0.5 + surgePct / 200));
  // (b) persistence: heavy across the week, not one print.
  const persistence = recent.filter(v => v > HEAVY_MULT * baseAvg).length / VOL_RECENT;
  const authenticity = clamp01(0.6 * corroboration + 0.4 * persistence);
  const rawStrength = Math.max(0, surge);
  const surgeSignal = surge > 0.25;
  const volumeRaw = surgeSignal ? rawStrength * authenticity : 0;
  const trapRisk = surge > TRAP_SURGE && authenticity < TRAP_AUTH;
  let trapReason = null;
  if (trapRisk) {
    if (corroboration < 0.4) trapReason = `vol +${Math.round(surgePct)}% but price ~flat (${ret5Abs.toFixed(1)}% move)`;
    else if (persistence < 0.4) trapReason = `one-day blip (${Math.round(persistence * VOL_RECENT)} of ${VOL_RECENT} sessions heavy)`;
    else trapReason = 'low-conviction volume surge';
  }
  return { surge, surgePct, ret5Abs, corroboration, persistence, authenticity, volumeRaw, trapRisk, trapReason };
}

/**
 * 52-week strength from adjusted closes. `newHigh5` asks whether any of the
 * last 5 closes was the rolling 252-session high AT THAT BAR — a stock that
 * printed a high on Monday and eased since still counts this week.
 */
function fiftyTwoAt(closes, i) {
  if (i < FIFTY_TWO_WINDOW - 1) return null;
  const rollingMax = (j) => { let m = -Infinity; for (let k = j - FIFTY_TWO_WINDOW + 1; k <= j; k++) m = Math.max(m, closes[k]); return m; };
  const rollingMin = (j) => { let m = Infinity; for (let k = j - FIFTY_TWO_WINDOW + 1; k <= j; k++) m = Math.min(m, closes[k]); return m; };
  const high252 = rollingMax(i), low252 = rollingMin(i);
  let newHigh5 = false, newLow5 = false;
  for (let j = Math.max(FIFTY_TWO_WINDOW - 1, i - 4); j <= i; j++) {
    if (closes[j] >= rollingMax(j)) newHigh5 = true;
    if (closes[j] <= rollingMin(j)) newLow5 = true;
  }
  const nearHighPct = high252 > 0 ? clamp01(closes[i] / high252) : null;
  const fiftyTwoRaw = (newHigh5 ? 1 : 0) - (newLow5 ? 1 : 0) + (nearHighPct != null ? nearHighPct - 0.8 : 0);
  return { high252, low252, nearHighPct, newHigh5, newLow5, fiftyTwoRaw };
}

/** 63-session return minus SPY's, in percentage points. */
function relStrengthAt(closes, spyCloses, i) {
  const b = i - RS_WINDOW;
  if (b < 0) return null;
  const c0 = closes[b], s0 = spyCloses?.[b], c1 = closes[i], s1 = spyCloses?.[i];
  if (!(c0 > 0) || !(s0 > 0) || c1 == null || s1 == null) return null;
  return ((c1 / c0 - 1) - (s1 / s0 - 1)) * 100;
}

/** Median dollar volume over the 20 sessions ending at i. */
function dollarVolumeMedianAt(closes, volumes, i) {
  if (i < 19) return null;
  const xs = [];
  for (let k = i - 19; k <= i; k++) xs.push(closes[k] * volumes[k]);
  xs.sort((a, b) => a - b);
  return (xs[9] + xs[10]) / 2;
}

/** Everything the engine records for one symbol at bar i. */
function factorRowAt({ closes, volumes, spyCloses }, i, { momentum = {} } = {}) {
  const vol = volumeAt(closes, volumes, i);
  const ft = fiftyTwoAt(closes, i);
  const sma50 = smaAt(closes, 50, i), sma200 = smaAt(closes, 200, i);
  return {
    momentumRaw: momentumAt(closes, i, momentum),
    ...vol,
    fiftyTwoRaw: ft ? ft.fiftyTwoRaw : null,
    nearHighPct: ft ? ft.nearHighPct : null,
    newHigh5: ft ? ft.newHigh5 : false,
    newLow5: ft ? ft.newLow5 : false,
    relStrengthRaw: relStrengthAt(closes, spyCloses, i),
    dollarVolume: dollarVolumeMedianAt(closes, volumes, i),
    aboveSma50: sma50 != null ? closes[i] >= sma50 : null,
    aboveSma200: sma200 != null ? closes[i] >= sma200 : null,
  };
}

/** Market breadth over the universe's factor rows. */
function breadth(rows) {
  const pct = (pred) => {
    const known = rows.filter(r => pred(r) != null);
    return known.length ? +(known.filter(r => pred(r) === true).length / known.length * 100).toFixed(1) : null;
  };
  const pctAbove50 = pct(r => r.aboveSma50);
  const pctAbove200 = pct(r => r.aboveSma200);
  const pctPositiveMomentum = pct(r => (r.momentumRaw == null ? null : r.momentumRaw > 0));
  const label = pctAbove50 == null || pctAbove200 == null ? 'unknown'
    : pctAbove50 > 60 && pctAbove200 > 60 ? 'risk-on'
    : pctAbove50 < 40 && pctAbove200 < 40 ? 'risk-off'
    : 'mixed';
  return { pctAbove50, pctAbove200, pctPositiveMomentum, label };
}

module.exports = {
  momentumAt, volumeAt, fiftyTwoAt, relStrengthAt, dollarVolumeMedianAt, smaAt, factorRowAt, breadth,
  MOM_WINDOW, MOM_SKIP, RS_WINDOW, FIFTY_TWO_WINDOW, TRAP_SURGE, TRAP_AUTH, HEAVY_MULT,
};
```

- [ ] **Step 4: Run tests**

Run: `cd backend && node --test usPicks/factors.test.js`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/usPicks/factors.js backend/usPicks/factors.test.js
git commit -m "usPicks: factor maths — momentum, volume conviction, 52-week, relative strength, breadth

Pure functions over aligned arrays, reading index i and earlier only, so the
same code runs live and in the backtest.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: EPS revisions

**Files:**
- Create: `backend/usPicks/revisions.js`, `backend/usPicks/revisions.test.js`

**Interfaces:**
- Produces: `revisionsRawFrom(earningsTrend) → number|null`; `fetchRevisions(symbols, { fetchOne = yahooEarningsTrend, gapMs = 150 } = {}) → { bySymbol: Map<symbol, number|null>, missing: number }` with a 24h in-memory cache keyed by symbol.

- [ ] **Step 1: Write the failing tests**

```js
// backend/usPicks/revisions.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { revisionsRawFrom, fetchRevisions, _resetCache } = require('./revisions');

const et = (o) => ({ trend: [{ period: '0y', epsRevisions: { upLast30days: o.up, downLast30days: o.down }, epsTrend: { current: o.now, '30daysAgo': o.ago } }] });

describe('revisionsRawFrom', () => {
  test('all upgrades and a rising estimate is +1', () => {
    assert.ok(Math.abs(revisionsRawFrom(et({ up: 5, down: 0, now: 1.2, ago: 1.0 })) - 1) < 1e-9);
  });
  test('all downgrades and a falling estimate is −1', () => {
    assert.ok(Math.abs(revisionsRawFrom(et({ up: 0, down: 4, now: 0.8, ago: 1.0 })) - (-1)) < 1e-9);
  });
  test('the trend change is clamped at ±20%', () => {
    const a = revisionsRawFrom(et({ up: 0, down: 0, now: 3, ago: 1 }));
    const b = revisionsRawFrom(et({ up: 0, down: 0, now: 1.2, ago: 1 }));
    assert.ok(Math.abs(a - b) < 1e-9, 'a 200% jump scores the same as 20%');
  });
  test('no revisions but a trend uses the trend alone', () => {
    assert.ok(Math.abs(revisionsRawFrom(et({ up: 0, down: 0, now: 1.1, ago: 1.0 })) - 0.5) < 1e-9);
  });
  test('nothing usable is null, not zero', () => {
    assert.equal(revisionsRawFrom(null), null);
    assert.equal(revisionsRawFrom({ trend: [] }), null);
    assert.equal(revisionsRawFrom(et({ up: 0, down: 0, now: null, ago: null })), null);
  });
});

describe('fetchRevisions', () => {
  test('caches per symbol and counts misses', async () => {
    _resetCache();
    let calls = 0;
    const fetchOne = async (sym) => { calls++; return sym === 'BAD' ? null : et({ up: 1, down: 0, now: 1, ago: 1 }); };
    const r1 = await fetchRevisions(['AAA', 'BAD'], { fetchOne, gapMs: 0 });
    assert.equal(r1.bySymbol.get('AAA'), 0.5);
    assert.equal(r1.bySymbol.get('BAD'), null);
    assert.equal(r1.missing, 1);
    await fetchRevisions(['AAA', 'BAD'], { fetchOne, gapMs: 0 });
    assert.equal(calls, 2, 'second call served from cache');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test usPicks/revisions.test.js`
Expected: FAIL — `Cannot find module './revisions'`

- [ ] **Step 3: Implement `backend/usPicks/revisions.js`**

```js
// ─── EPS estimate revisions (Yahoo earningsTrend) ────────────────────────────
//
// The one factor here that is not price. It cannot be backtested — Yahoo
// exposes only the CURRENT estimate and the count of revisions in the last 30
// days, with no vintage history — so it is scored forward only, from the
// percentiles the daily snapshot records. Until ~20 snapshot days have
// resolved its badge says so.
//
// ~560 quoteSummary calls a day, chunked and cached 24h, run inside the daily
// job rather than on page load.

const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const TTL = 24 * 60 * 60 * 1000;
const CHUNK = 8;
let cache = new Map(); // symbol -> { raw, ts }
const _resetCache = () => { cache = new Map(); };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 0.5 · net revision ratio + 0.5 · clamped 30-day trend change. Either half
 * alone when the other is missing; null when both are.
 */
function revisionsRawFrom(earningsTrend) {
  const row = (earningsTrend?.trend || []).find(t => t.period === '0y');
  if (!row) return null;
  const up = row.epsRevisions?.upLast30days ?? 0;
  const down = row.epsRevisions?.downLast30days ?? 0;
  const net = up + down > 0 ? (up - down) / (up + down) : null;
  const now = row.epsTrend?.current, ago = row.epsTrend?.['30daysAgo'];
  const trend = (now != null && ago != null && ago !== 0) ? clamp(now / ago - 1, -0.2, 0.2) / 0.2 : null;
  if (net == null && trend == null) return null;
  if (net == null) return 0.5 * trend;
  if (trend == null) return 0.5 * net;
  return 0.5 * net + 0.5 * trend;
}

async function yahooEarningsTrend(symbol) {
  const q = await yf.quoteSummary(symbol.replace(/\./g, '-'), { modules: ['earningsTrend'] }, { validateResult: false });
  return q?.earningsTrend || null;
}

async function fetchRevisions(symbols, { fetchOne = yahooEarningsTrend, gapMs = 150 } = {}) {
  const bySymbol = new Map();
  let missing = 0;
  const todo = [];
  for (const s of symbols) {
    const hit = cache.get(s);
    if (hit && Date.now() - hit.ts < TTL) bySymbol.set(s, hit.raw);
    else todo.push(s);
  }
  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    const rows = await Promise.all(chunk.map(s => fetchOne(s).catch(() => null)));
    chunk.forEach((s, j) => {
      const raw = revisionsRawFrom(rows[j]);
      cache.set(s, { raw, ts: Date.now() });
      bySymbol.set(s, raw);
    });
    if (gapMs && i + CHUNK < todo.length) await new Promise(r => setTimeout(r, gapMs));
  }
  for (const v of bySymbol.values()) if (v == null) missing++;
  return { bySymbol, missing };
}

module.exports = { revisionsRawFrom, fetchRevisions, _resetCache };
```

- [ ] **Step 4: Run tests**

Run: `cd backend && node --test usPicks/revisions.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/usPicks/revisions.js backend/usPicks/revisions.test.js
git commit -m "usPicks: EPS revisions factor from Yahoo earningsTrend, cached daily

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The engine — inputs, universe, ranking

**Files:**
- Create: `backend/usPicks/engine.js`, `backend/usPicks/engine.test.js`

**Interfaces:**
- Consumes: `fetchBarsMulti` (Task 1), `barFlags` (Task 2), `getEarningsCalendar` (Task 2), `factorRowAt`/`breadth`/`dollarVolumeMedianAt` (Task 3), `fetchRevisions` (Task 4), `getSP500`/`getNasdaq100` from `backend/usUniverses.js`.
- Produces:
  - `loadInputs({ from, includeRevisions = true, includeEarnings = true }) → { members, barsBySymbol, spyBars, earningsBySymbol: Map, revisionsBySymbol: Map, revisionsMissing, macroLabel }` where `barsBySymbol[sym] = [{ date: 'YYYY-MM-DD', open, high, low, close, volume }]` sorted ascending; `spyBars` same shape.
  - `buildUniverseFrom(inputs, { asOf = null, momentum = {} } = {}) → { period: { asOf, snapshotDate }, regime, excludedCount, excludedSample, revisionsMissing, universeSize, stocks }` with `stocks[i] = { symbol, name, sector, lastClose, earningsDate, flags: [{id,severity,title}], factors: { momentumRaw, volumeRaw, fiftyTwoRaw, relStrengthRaw, revisionsRaw, trapRisk, trapReason, surgePct, authenticity, nearHighPct, newHigh5, newLow5, dollarVolume } }`.
  - `buildUsFactorUniverse(opts)`; `rankUniverse(stocks, weights = DEFAULT_WEIGHTS, { excludeTraps = true })` → rows with `pct` and `composite`, sorted, `rank` 1-based; `DEFAULT_WEIGHTS`, `BACKTEST_WEIGHTS`, `FACTOR_RAW`, `percentileRanks(values)` (null → 50).
  - `ILLIQUID_FLOOR = 10e6`, `EARNINGS_WINDOW = 5`.

- [ ] **Step 1: Write the failing tests** (pure parts only — `buildUniverseFrom`, `rankUniverse`, `percentileRanks`)

```js
// backend/usPicks/engine.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildUniverseFrom, rankUniverse, percentileRanks, DEFAULT_WEIGHTS, BACKTEST_WEIGHTS } = require('./engine');

const day = (i) => { const d = new Date(Date.UTC(2024, 0, 1)); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); };
const bars = (n, from, step, vol = 1e6) => Array.from({ length: n }, (_, i) => {
  const c = from + i * step;
  return { date: day(i), open: c, high: c * 1.01, low: c * 0.99, close: c, volume: vol };
});
const inputs = (over = {}) => ({
  members: [{ symbol: 'UP', name: 'Up Co', sector: 'Tech' }, { symbol: 'DOWN', name: 'Down Co', sector: 'Energy' }, { symbol: 'THIN', name: 'Thin Co', sector: 'Tech' }],
  barsBySymbol: { UP: bars(300, 100, 0.5), DOWN: bars(300, 200, -0.3), THIN: bars(300, 1, 0.001, 100) },
  spyBars: bars(300, 400, 0.1),
  earningsBySymbol: new Map(),
  revisionsBySymbol: new Map([['UP', 0.8]]),
  revisionsMissing: 2,
  macroLabel: 'neutral',
  ...over,
});

describe('percentileRanks', () => {
  test('nulls sit at exactly 50, others rank among themselves', () => {
    assert.deepEqual(percentileRanks([1, null, 3]), [25, 50, 75]);
  });
  test('ties share the middle of their block', () => {
    assert.deepEqual(percentileRanks([0, 0, 0, 5]), [37.5, 37.5, 37.5, 87.5]);
  });
});

describe('buildUniverseFrom', () => {
  test('ranks the trend leader above the laggard and drops the illiquid name', () => {
    const u = buildUniverseFrom(inputs());
    const syms = u.stocks.map(s => s.symbol);
    assert.ok(syms.includes('UP') && syms.includes('DOWN'));
    assert.ok(!syms.includes('THIN'), 'below the $10M floor');
    assert.equal(u.excludedCount, 1);
    assert.match(u.excludedSample[0], /THIN/);
    const up = u.stocks.find(s => s.symbol === 'UP');
    assert.ok(up.factors.momentumRaw > 0);
    assert.ok(up.factors.relStrengthRaw > 0);
    assert.equal(up.factors.revisionsRaw, 0.8);
    assert.equal(u.stocks.find(s => s.symbol === 'DOWN').factors.revisionsRaw, null);
  });

  test('excludes a name reporting within 5 sessions', () => {
    const u = buildUniverseFrom(inputs({ earningsBySymbol: new Map([['UP', day(301)]]) }));
    assert.ok(!u.stocks.some(s => s.symbol === 'UP'));
    assert.ok(u.excludedSample.some(x => /earnings/.test(x)));
  });

  test('keeps a name reporting 10 sessions out, with the date attached', () => {
    const u = buildUniverseFrom(inputs({ earningsBySymbol: new Map([['UP', day(315)]]) }));
    assert.equal(u.stocks.find(s => s.symbol === 'UP').earningsDate, day(315));
  });

  test('asOf evaluates at the last bar on or before that date, and only sees earlier bars', () => {
    const full = buildUniverseFrom(inputs(), { asOf: day(250) });
    assert.equal(full.period.snapshotDate, day(250));
    const trimmed = buildUniverseFrom(inputs({ barsBySymbol: { UP: bars(251, 100, 0.5), DOWN: bars(251, 200, -0.3), THIN: bars(251, 1, 0.001, 100) }, spyBars: bars(251, 400, 0.1) }));
    assert.equal(full.stocks.find(s => s.symbol === 'UP').factors.momentumRaw, trimmed.stocks.find(s => s.symbol === 'UP').factors.momentumRaw);
  });

  test('regime carries breadth and the macro label', () => {
    const u = buildUniverseFrom(inputs());
    assert.equal(u.regime.macro, 'neutral');
    assert.ok(['risk-on', 'risk-off', 'mixed'].includes(u.regime.breadth.label));
    assert.match(u.regime.label, /Breadth/);
  });
});

describe('rankUniverse', () => {
  test('weights sum to 100 and the backtest zeroes revisions', () => {
    assert.equal(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0), 100);
    assert.equal(BACKTEST_WEIGHTS.revisions, 0);
  });
  test('excludes traps by default and ranks 1..n', () => {
    const stocks = [
      { symbol: 'A', factors: { momentumRaw: 0.2, volumeRaw: 1, fiftyTwoRaw: 1, relStrengthRaw: 5, revisionsRaw: 0.5, trapRisk: false } },
      { symbol: 'B', factors: { momentumRaw: 0.1, volumeRaw: 0, fiftyTwoRaw: 0, relStrengthRaw: 0, revisionsRaw: null, trapRisk: false } },
      { symbol: 'T', factors: { momentumRaw: 0.9, volumeRaw: 9, fiftyTwoRaw: 1, relStrengthRaw: 9, revisionsRaw: 1, trapRisk: true } },
    ];
    const r = rankUniverse(stocks);
    assert.deepEqual(r.map(x => x.symbol), ['A', 'B']);
    assert.deepEqual(r.map(x => x.rank), [1, 2]);
    assert.equal(rankUniverse(stocks, DEFAULT_WEIGHTS, { excludeTraps: false })[0].symbol, 'T');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test usPicks/engine.test.js`
Expected: FAIL — `Cannot find module './engine'`

- [ ] **Step 3: Implement `backend/usPicks/engine.js`**

```js
// ─── US Quant Picks engine ───────────────────────────────────────────────────
//
// The Indian engine (picks/engine.js) with the parts this market can supply.
// Same shape on purpose: raw factors per stock from the server, percentile
// ranking and weights on the client so sliders re-rank instantly, and ONE
// deterministic default-weight series written to the snapshot table every
// session — that series is the track record, and nothing a user does with the
// sliders touches it.
//
// Two layers, kept apart so the backtest can use the second without the first:
//
//   loadInputs()        fetches — bars for the whole universe in a handful of
//                       multi-symbol calls, membership, earnings dates, EPS
//                       revisions, the macro label.
//   buildUniverseFrom() computes — factor rows, exclusions, regime — from those
//                       inputs at an `asOf` date. Pure. Runs at any past date
//                       on the same bars, which is what makes the backtest an
//                       evaluation of THIS code rather than a copy of it.

const { createClient } = require('@supabase/supabase-js');
const { fetchBarsMulti } = require('../alpacaData');
const { barFlags } = require('../usRedFlags');
const { getSP500, getNasdaq100 } = require('../usUniverses');
const { fetchRevisions } = require('./revisions');
const F = require('./factors');

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

const BENCHMARK = 'SPY';
const ILLIQUID_FLOOR = 10e6;   // median $ volume / day — the ₹1cr floor's analogue
const EARNINGS_WINDOW = 5;     // sessions; a report inside it is a coin flip, not a factor bet
const LIVE_MONTHS = 15;        // 252 for the 52-week window + 63 for RS + holidays

const DEFAULT_WEIGHTS = { momentum: 30, volume: 20, fiftyTwo: 15, relStrength: 20, revisions: 15 };
// The backtest cannot see historical estimate revisions, so it scores the four
// price factors and SAYS so. Not a different model — the same one with one
// input unavailable.
const BACKTEST_WEIGHTS = { ...DEFAULT_WEIGHTS, revisions: 0 };
const FACTOR_RAW = { momentum: 'momentumRaw', volume: 'volumeRaw', fiftyTwo: 'fiftyTwoRaw', relStrength: 'relStrengthRaw', revisions: 'revisionsRaw' };

const round = (v, p = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(p));
const isoDay = (d) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** S&P 500 ∪ Nasdaq 100, one row per symbol, GICS sector where the scrape has it. */
async function loadMembers() {
  const [sp, ndx] = await Promise.all([getSP500().catch(() => []), getNasdaq100().catch(() => [])]);
  const out = new Map();
  for (const m of sp) out.set(m.symbol, { symbol: m.symbol, name: m.name || m.symbol, sector: m.sector || null });
  for (const m of ndx) if (!out.has(m.symbol)) out.set(m.symbol, { symbol: m.symbol, name: m.name || m.symbol, sector: m.sector || null });
  return [...out.values()];
}

/** symbol -> next earnings date (ISO), from the cached calendar. */
async function loadEarnings() {
  // Required lazily: alpaca.js is the router and pulls in everything.
  const { getEarningsCalendar } = require('../alpaca');
  const cal = await getEarningsCalendar().catch(() => ({ events: [] }));
  const m = new Map();
  for (const e of cal.events || []) if (!m.has(e.symbol)) m.set(e.symbol, e.date);
  return m;
}

/** The latest recorded macro regime label, or null when the table is absent. */
async function loadMacroLabel() {
  if (!supabase) return null;
  const { data, error } = await supabase.from('macro_signal_snapshots')
    .select('regime').order('snap_date', { ascending: false }).limit(1);
  if (error) return null;
  return data?.[0]?.regime || null;
}

const normaliseBars = (arr) => (arr || [])
  .map(b => ({ ...b, date: isoDay(b.date) }))
  .sort((a, b) => a.date.localeCompare(b.date));

async function loadInputs({ from = null, includeRevisions = true, includeEarnings = true } = {}) {
  const members = await loadMembers();
  const symbols = members.map(m => m.symbol);
  const start = from ? new Date(from) : (() => { const d = new Date(); d.setMonth(d.getMonth() - LIVE_MONTHS); return d; })();
  const [raw, earningsBySymbol, revisions, macroLabel] = await Promise.all([
    fetchBarsMulti([...symbols, BENCHMARK], start),
    includeEarnings ? loadEarnings() : new Map(),
    includeRevisions ? fetchRevisions(symbols) : { bySymbol: new Map(), missing: 0 },
    loadMacroLabel(),
  ]);
  const barsBySymbol = {};
  for (const s of symbols) if (raw[s]?.length) barsBySymbol[s] = normaliseBars(raw[s]);
  return {
    members, barsBySymbol, spyBars: normaliseBars(raw[BENCHMARK]),
    earningsBySymbol, revisionsBySymbol: revisions.bySymbol, revisionsMissing: revisions.missing, macroLabel,
  };
}

// ─── Universe ────────────────────────────────────────────────────────────────

/** Index of the last bar with date ≤ asOf, or -1. */
function indexAsOf(bars, asOf) {
  if (!asOf) return bars.length - 1;
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].date <= asOf) lo = mid + 1; else hi = mid; }
  return lo - 1;
}

/** Sessions between two ISO dates on the SPY calendar (inclusive of neither). */
function sessionsUntil(spyDates, fromDate, toDate) {
  let n = 0;
  for (const d of spyDates) if (d > fromDate && d <= toDate) n++;
  return n;
}

function buildUniverseFrom(inputs, { asOf = null, momentum = {} } = {}) {
  const { members, barsBySymbol, spyBars, earningsBySymbol, revisionsBySymbol, revisionsMissing, macroLabel } = inputs;
  const spyIdx = indexAsOf(spyBars, asOf);
  if (spyIdx < 0) throw new Error('No SPY bars on or before asOf');
  const snapshotDate = spyBars[spyIdx].date;
  // SPY closes keyed by date so a symbol missing a session still aligns.
  const spyByDate = new Map(spyBars.map(b => [b.date, b.close]));
  const spyDates = spyBars.map(b => b.date);

  const stocks = [];
  let excludedCount = 0;
  const excludedSample = [];
  const exclude = (sym, why) => { excludedCount++; if (excludedSample.length < 8) excludedSample.push(`${sym} (${why})`); };

  for (const m of members) {
    const bars = barsBySymbol[m.symbol];
    if (!bars?.length) continue;
    const i = indexAsOf(bars, snapshotDate);
    if (i < 0) continue;
    const upTo = bars.slice(0, i + 1);
    const closes = upTo.map(b => b.close);
    const volumes = upTo.map(b => b.volume);
    const spyCloses = upTo.map(b => spyByDate.get(b.date) ?? null);

    const f = F.factorRowAt({ closes, volumes, spyCloses }, i, { momentum });
    if (f.momentumRaw == null) continue; // not enough history to rank at all

    if (f.dollarVolume != null && f.dollarVolume < ILLIQUID_FLOOR) { exclude(m.symbol, `illiquid: $${(f.dollarVolume / 1e6).toFixed(1)}M/day`); continue; }
    const earningsDate = earningsBySymbol.get(m.symbol) || null;
    if (earningsDate && earningsDate >= snapshotDate && sessionsUntil(spyDates, snapshotDate, earningsDate) <= EARNINGS_WINDOW) {
      exclude(m.symbol, `earnings ${earningsDate}`); continue;
    }
    const flags = F.dollarVolumeMedianAt(closes, volumes, i) == null ? [] : barFlags(upTo.slice(-60));
    if (flags.some(x => x.severity === 'red')) { exclude(m.symbol, flags.find(x => x.severity === 'red').id); continue; }

    const revisionsRaw = revisionsBySymbol.has(m.symbol) ? revisionsBySymbol.get(m.symbol) : null;
    stocks.push({
      symbol: m.symbol, name: m.name, sector: m.sector,
      lastClose: round(closes[i]),
      earningsDate,
      flags: flags.map(x => ({ id: x.id, severity: x.severity, title: x.title })),
      factors: {
        momentumRaw: round(f.momentumRaw, 4),
        volumeRaw: round(f.volumeRaw, 3), surgePct: round(f.surgePct, 0), authenticity: f.authenticity == null ? null : round(f.authenticity * 100, 0),
        trapRisk: f.trapRisk, trapReason: f.trapReason,
        fiftyTwoRaw: round(f.fiftyTwoRaw, 3), nearHighPct: round(f.nearHighPct, 3), newHigh5: f.newHigh5, newLow5: f.newLow5,
        relStrengthRaw: round(f.relStrengthRaw, 2),
        revisionsRaw: revisionsRaw == null ? null : round(revisionsRaw, 3),
        dollarVolume: round(f.dollarVolume, 0),
        aboveSma50: f.aboveSma50, aboveSma200: f.aboveSma200,
      },
    });
  }

  const b = F.breadth(stocks.map(s => ({ aboveSma50: s.factors.aboveSma50, aboveSma200: s.factors.aboveSma200, momentumRaw: s.factors.momentumRaw })));
  const regime = {
    breadth: b, macro: macroLabel,
    label: `Breadth ${b.label} (${b.pctAbove50 ?? '—'}% > 50D, ${b.pctAbove200 ?? '—'}% > 200D)${macroLabel ? ` · macro ${macroLabel}` : ''}`,
  };

  return {
    period: { asOf: asOf || snapshotDate, snapshotDate },
    regime,
    excludedCount, excludedSample,
    revisionsMissing: revisionsMissing ?? 0,
    universeSize: stocks.length,
    generatedAt: new Date().toISOString(),
    stocks,
  };
}

async function buildUsFactorUniverse(opts = {}) {
  return buildUniverseFrom(await loadInputs(opts), opts);
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

/**
 * Mid-rank percentiles, 0–100. Ties share the middle of their block. `null`
 * means "no data" and lands at exactly 50 — the one place this differs from
 * India's `?? 0`, because a missing revision is not a bad revision.
 */
function percentileRanks(values) {
  const known = values.filter(v => v != null);
  const sorted = [...known].sort((a, b) => a - b);
  const n = sorted.length;
  return values.map(v => {
    if (v == null) return 50;
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    const first = lo;
    hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid + 1; else hi = mid; }
    return n ? ((first + lo) / 2 / n) * 100 : 50;
  });
}

function rankUniverse(stocks, weights = DEFAULT_WEIGHTS, { excludeTraps = true } = {}) {
  const pool = excludeTraps ? stocks.filter(s => !s.factors.trapRisk) : stocks;
  const keys = Object.keys(FACTOR_RAW);
  const cols = {};
  for (const k of keys) cols[k] = percentileRanks(pool.map(s => s.factors[FACTOR_RAW[k]]));
  const sumW = keys.reduce((a, k) => a + (weights[k] || 0), 0) || 1;
  return pool
    .map((s, i) => {
      const pct = {}; let composite = 0;
      for (const k of keys) { pct[k] = cols[k][i]; composite += ((weights[k] || 0) / sumW) * pct[k]; }
      return { ...s, pct, composite };
    })
    .sort((a, b) => b.composite - a.composite)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

// ─── Snapshots ───────────────────────────────────────────────────────────────

/** Persist the default-weight top 25 for one session. Table: migrate_us_pick_snapshots.js. */
async function saveDailySnapshot(universe) {
  if (!supabase) throw new Error('Supabase not configured');
  const snapDate = universe.period.snapshotDate;
  const top = rankUniverse(universe.stocks).slice(0, 25);
  if (!top.length) return { snapDate, saved: 0 };
  const rows = top.map(r => ({
    snap_date: snapDate, symbol: r.symbol, rank: r.rank,
    composite: +r.composite.toFixed(2),
    momentum_pct: +r.pct.momentum.toFixed(1), volume_pct: +r.pct.volume.toFixed(1),
    fifty_two_pct: +r.pct.fiftyTwo.toFixed(1), rel_strength_pct: +r.pct.relStrength.toFixed(1),
    revisions_pct: +r.pct.revisions.toFixed(1), revisions_raw: r.factors.revisionsRaw,
    trap_risk: !!r.factors.trapRisk, last_close: r.lastClose,
  }));
  const { error } = await supabase.from('us_pick_snapshots').upsert(rows, { onConflict: 'snap_date,symbol' });
  if (error) throw new Error(`us_pick_snapshots: ${error.message}`);
  return { snapDate, saved: rows.length };
}

async function fetchSnapshotHistory(sinceDate) {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from('us_pick_snapshots')
    .select('snap_date,symbol,rank,composite,trap_risk,last_close')
    .gte('snap_date', sinceDate)
    .order('snap_date', { ascending: false }).order('rank', { ascending: true }).limit(5000);
  if (error) throw new Error(`us_pick_snapshots: ${error.message}`);
  const byDate = new Map();
  for (const r of data || []) {
    if (!byDate.has(r.snap_date)) byDate.set(r.snap_date, []);
    byDate.get(r.snap_date).push({ symbol: r.symbol, rank: r.rank, composite: r.composite, trapRisk: r.trap_risk, lastClose: r.last_close });
  }
  return [...byDate.entries()].map(([date, picks]) => ({ date, picks }));
}

module.exports = {
  loadInputs, buildUniverseFrom, buildUsFactorUniverse, rankUniverse, percentileRanks,
  saveDailySnapshot, fetchSnapshotHistory, indexAsOf,
  DEFAULT_WEIGHTS, BACKTEST_WEIGHTS, FACTOR_RAW, BENCHMARK, ILLIQUID_FLOOR, EARNINGS_WINDOW,
};
```

- [ ] **Step 4: Run tests**

Run: `cd backend && node --test usPicks/engine.test.js`
Expected: PASS (9 tests). If the illiquid test fails, check `THIN` bars: close ~1 × volume 100 = $100/day, far under the floor.

- [ ] **Step 5: Smoke-run against Alpaca** (needs `.env`)

Run: `cd backend && node -e "require('dotenv').config({path:'../.env'}); require('./usPicks/engine').buildUsFactorUniverse({ includeRevisions: false }).then(u => console.log(u.period, u.regime.label, 'universe', u.universeSize, 'excluded', u.excludedCount, u.excludedSample)).catch(e => { console.error(e.message); process.exit(1); })"`
Expected: a snapshot date within the last few sessions, a regime line, universe ~500–560, a handful excluded.

- [ ] **Step 6: Commit**

```bash
git add backend/usPicks/engine.js backend/usPicks/engine.test.js
git commit -m "usPicks: engine — inputs, factor universe, exclusions, regime, ranking, snapshots

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Snapshot table, registry entries, Indian scorecard skip

**Files:**
- Create: `backend/migrate_us_pick_snapshots.js`
- Modify: `backend/signals/registry.js` (`RECORDED_SIGNALS`, ~line 521), `backend/signals/scorecard.js` (`headline`, `neverFired`), `backend/signals/registry.test.js`, `backend/signals/scorecard.test.js`

**Interfaces:**
- Produces: registry entries `us_picks_top25`, `us_picks_top10` with `market: 'US'`, `scoredBy: '/api/us/stock-picks/scorecard'`; `headline(rows, { source, blockedReason, direction, benchmarkLabel = 'NIFTY' })`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/signals/registry.test.js`:

```js
describe('US signals in the registry', () => {
  test('are declared as scored elsewhere, never against NIFTY', () => {
    for (const name of ['us_picks_top25', 'us_picks_top10']) {
      const s = signalMeta(name);
      assert.ok(s, `${name} is registered`);
      assert.equal(s.market, 'US');
      assert.equal(s.source, 'recorded');
      assert.match(s.scoredBy, /\/api\/us\/stock-picks\/scorecard/);
    }
  });
});
```

Append to `backend/signals/scorecard.test.js` inside `describe('headline', …)`:

```js
  test('names the benchmark it was given', () => {
    const h = headline(rows({ '10d': { n: 60, unresolved: 0, medianExcessPct: 1.4 } }), { benchmarkLabel: 'SPY' });
    assert.match(h.text, /vs SPY over 10d/);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test signals/registry.test.js signals/scorecard.test.js`
Expected: 2 FAIL (missing registry entries; text says NIFTY)

- [ ] **Step 3: Registry entries**

In `backend/signals/registry.js`, after the `high_52w` entry in `RECORDED_SIGNALS`, add:

```js
  // US picks. Recorded to us_pick_snapshots and scored against SPY by
  // usPicks/scorecard.js — NOT by signals/scorecard.js, whose calendar and
  // benchmark are Indian. `market` is the flag that scorer honours; without it
  // an entry here would be scored against NIFTY on a bhavcopy calendar and
  // rendered as if that meant something.
  { name: 'us_picks_top25', label: 'US quant picks (top 25)', source: 'recorded', market: 'US', scoredBy: '/api/us/stock-picks/scorecard', description: 'Every symbol written to us_pick_snapshots that day. Excess over SPY.' },
  { name: 'us_picks_top10', label: 'US quant picks (top 10)', source: 'recorded', market: 'US', scoredBy: '/api/us/stock-picks/scorecard', description: 'The top 10 of the same snapshot — tests whether rank ordering carries information.' },
```

- [ ] **Step 4: Scorecard changes**

In `backend/signals/scorecard.js`:

1. `headline` signature and the two strings:

```js
function headline(rows, { source, blockedReason, direction = 'bullish', benchmarkLabel = 'NIFTY' } = {}) {
```
and
```js
  const sign = `${edge > 0 ? '+' : ''}${edge}% vs ${benchmarkLabel} over 10d (n=${mid.n})`;
```

2. In `runSignalScorecard`, the `neverFired` filter becomes:

```js
  const neverFired = ALL_SIGNALS
    // market:'US' entries are recorded and scored by their own endpoint (see
    // registry); listing them here as "never recorded" would be false.
    .filter(s => !seen.has(s.name) && !s.blockedReason && s.market !== 'US')
```

- [ ] **Step 5: Migration script** — `backend/migrate_us_pick_snapshots.js`:

```js
// Run once: node migrate_us_pick_snapshots.js
//
// Daily default-weight top-25 US quant-pick snapshots — the model's
// out-of-sample track record, written once per US session by dailyJobs (or
// POST /api/us/stock-picks/snapshot). Supabase's JS client can't run DDL, so
// this prints the CREATE TABLE statement for the Supabase SQL editor, then
// verifies the table is reachable. No seed data — history accumulates from the
// first snapshot on.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const DDL = `
-- One row per (session, symbol): the default-weight top-25 US quant picks that day.
-- Per-factor percentiles are stored so a factor's forward IC can be measured from
-- what was actually recorded — that is how EPS revisions, which cannot be
-- backtested, earns or loses its weight.
create table if not exists us_pick_snapshots (
  snap_date          date    not null,
  symbol             text    not null,
  rank               int     not null,
  composite          numeric,
  momentum_pct       numeric,
  volume_pct         numeric,
  fifty_two_pct      numeric,
  rel_strength_pct   numeric,
  revisions_pct      numeric,
  revisions_raw      numeric,
  trap_risk          boolean default false,
  last_close         numeric,
  created_at         timestamptz default now(),
  primary key (snap_date, symbol)
);
create index if not exists us_pick_snapshots_symbol_idx on us_pick_snapshots (symbol, snap_date desc);
`;

async function main() {
  console.log('\n=== Run this SQL in your Supabase SQL editor (one-time) ===');
  console.log(DDL);
  console.log('===========================================================\n');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.log('SUPABASE_URL / SUPABASE_SERVICE_KEY not set — skipping verification.');
    return;
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { error } = await supabase.from('us_pick_snapshots').select('snap_date', { count: 'exact', head: true });
  if (error) console.log(`Not reachable yet: ${error.message}\nPaste the SQL above, then re-run this script.`);
  else console.log('us_pick_snapshots is reachable.');
}
main().catch(err => { console.error(err.message); process.exit(1); });
```

- [ ] **Step 6: Run tests**

Run: `cd backend && node --test signals/registry.test.js signals/scorecard.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/migrate_us_pick_snapshots.js backend/signals/registry.js backend/signals/scorecard.js backend/signals/registry.test.js backend/signals/scorecard.test.js
git commit -m "US picks: snapshot table migration, registry entries scored elsewhere

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: US market series and the recorded-picks scorecard

**Files:**
- Create: `backend/signals/usMarketSeries.js`, `backend/usPicks/scorecard.js`, `backend/usPicks/scorecard.test.js`

**Interfaces:**
- Consumes: `fetchBarsMulti` (Task 1), `scoreSignal`/`summarise` from `backend/signalScoring.js`, `headline`/`present`/`MIN_N` from `backend/signals/scorecard.js`, `percentileRanks` (Task 5).
- Produces: `buildUsMarketContext(symbols, since) → { calendar, calendarGaps: [], seriesBySymbol, benchmark, benchmarkSymbol: 'SPY' }`; `runUsPicksScorecard({ fetchRows = defaultFetch, context = buildUsMarketContext } = {})` → `{ params, period, overall, top10, factorIC, signals: [badge entries], caveats, generatedAt }`; pure helper `factorICFromRows(rows, seriesBySymbol, horizon)`.

- [ ] **Step 1: Write the failing test**

```js
// backend/usPicks/scorecard.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { runUsPicksScorecard, factorICFromRows } = require('./scorecard');

const day = (i) => { const d = new Date(Date.UTC(2025, 0, 2)); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); };
const cal = Array.from({ length: 60 }, (_, i) => day(i));
const series = (start, step) => cal.map((d, i) => ({ date: d, close: start + i * step }));

describe('factorICFromRows', () => {
  test('a factor whose percentile orders the forward returns has IC +1', () => {
    const seriesBySymbol = { A: series(100, 1), B: series(100, 0.5), C: series(100, 0.1) };
    const rows = [
      { date: day(0), symbol: 'A', momentum_pct: 90, volume_pct: 10 },
      { date: day(0), symbol: 'B', momentum_pct: 50, volume_pct: 50 },
      { date: day(0), symbol: 'C', momentum_pct: 10, volume_pct: 90 },
    ];
    const ic = factorICFromRows(rows, seriesBySymbol, 10);
    assert.equal(ic.momentum.meanIC, 1);
    assert.equal(ic.volume.meanIC, -1);
    assert.equal(ic.momentum.dates, 1);
  });
});

describe('runUsPicksScorecard', () => {
  test('scores recorded rows against SPY and shapes badge entries', async () => {
    const rows = [];
    for (let d = 0; d < 30; d++) for (const [sym, rank] of [['A', 1], ['B', 12]]) {
      rows.push({ date: day(d), symbol: sym, rank, momentum_pct: 80, volume_pct: 50, fifty_two_pct: 50, rel_strength_pct: 50, revisions_pct: 50 });
    }
    const context = async () => ({
      calendar: cal, calendarGaps: [],
      seriesBySymbol: { A: series(100, 2), B: series(100, 1) },
      benchmark: series(400, 0.5), benchmarkSymbol: 'SPY',
    });
    const out = await runUsPicksScorecard({ fetchRows: async () => rows, context });
    assert.equal(out.params.benchmark, 'SPY');
    const top25 = out.signals.find(s => s.signal === 'us_picks_top25');
    assert.ok(top25);
    assert.equal(top25.source, 'recorded');
    assert.match(top25.headline.text, /vs SPY/);
    assert.equal(top25.headline.state, 'positive');
    assert.ok(out.signals.find(s => s.signal === 'us_picks_top10').firings < top25.firings);
  });

  test('says so when nothing is recorded', async () => {
    const out = await runUsPicksScorecard({ fetchRows: async () => [], context: async () => null });
    assert.equal(out.signals.length, 2);
    assert.equal(out.signals[0].headline.state, 'no-data');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test usPicks/scorecard.test.js`
Expected: FAIL — `Cannot find module './scorecard'`

- [ ] **Step 3: `backend/signals/usMarketSeries.js`**

```js
// ─── Shared price plumbing for the US scorers ────────────────────────────────
//
// The US sibling of marketSeries.js: a trading calendar, per-symbol closes laid
// onto it, and a benchmark on the same one. A separate module rather than a
// `market` flag threaded through the Indian one, because nothing about the two
// is shared beyond the shape — different source, different benchmark, and a
// calendar that comes from the benchmark's own bars instead of a price table
// that drops sessions.
//
// `calendarGaps` is reported for symmetry with the Indian scorer. Alpaca's
// daily bars have not shown holes; if they ever do, this is where it would
// surface, on the same field the UI already knows how to render.

const { fetchBarsMulti } = require('../alpacaData');
const { alignToCalendar } = require('./marketSeries');

const BENCHMARK = 'SPY';

async function buildUsMarketContext(symbols, since) {
  const raw = await fetchBarsMulti([...new Set([...symbols, BENCHMARK])], new Date(since));
  const byDate = (arr) => new Map((arr || []).map(b => [String(b.date).slice(0, 10), b.close]));
  const bench = byDate(raw[BENCHMARK]);
  const calendar = [...bench.keys()].filter(d => d >= since).sort();
  const seriesBySymbol = {};
  for (const s of symbols) seriesBySymbol[s] = alignToCalendar(calendar, byDate(raw[s]));
  return {
    calendar,
    calendarGaps: [],
    seriesBySymbol,
    benchmark: alignToCalendar(calendar, bench),
    benchmarkSymbol: BENCHMARK,
  };
}

module.exports = { BENCHMARK, buildUsMarketContext };
```

- [ ] **Step 4: `backend/usPicks/scorecard.js`**

```js
// ─── US picks scorecard — what was ACTUALLY recorded, scored against SPY ─────
//
// Same question picks/scorecard.js asks of the Indian picks: not "would the
// model have worked", which is the backtest's job, but "did the rows written to
// us_pick_snapshots that evening beat the index afterwards". No reconstruction.
//
// One thing India's scorer does not do: a per-factor information coefficient
// from the RECORDED percentiles. It is the only way EPS revisions — which has
// no vintage history and so no backtest — can ever be scored, and it is the
// reason the snapshot stores every factor's percentile rather than just the
// composite. Weak, because it is measured inside the top 25 only (the
// percentiles are already all high), and stated as such.

const { createClient } = require('@supabase/supabase-js');
const { scoreSignal } = require('../signalScoring');
const { headline, present, MIN_N } = require('../signals/scorecard');
const { buildUsMarketContext, BENCHMARK } = require('../signals/usMarketSeries');
const { signalMeta } = require('../signals/registry');

const HORIZONS = [5, 10, 22];
const FACTOR_COLS = { momentum: 'momentum_pct', volume: 'volume_pct', fiftyTwo: 'fifty_two_pct', relStrength: 'rel_strength_pct', revisions: 'revisions_pct' };

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY) : null;

async function defaultFetch() {
  if (!supabase) throw new Error('Supabase not configured');
  const PAGE = 1000;
  let offset = 0;
  const out = [];
  for (;;) {
    const { data, error } = await supabase.from('us_pick_snapshots')
      .select('snap_date,symbol,rank,momentum_pct,volume_pct,fifty_two_pct,rel_strength_pct,revisions_pct')
      .order('snap_date', { ascending: true }).order('rank', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`us_pick_snapshots: ${error.message}`);
    out.push(...(data || []).map(r => ({ ...r, date: r.snap_date })));
    if (!data || data.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

function midRanks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = r;
    i = j + 1;
  }
  return ranks;
}
function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const rx = midRanks(xs), ry = midRanks(ys);
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

/** Per-factor Spearman IC of recorded percentiles vs forward return, per snapshot day. */
function factorICFromRows(rows, seriesBySymbol, horizon) {
  const byDate = new Map();
  for (const r of rows) { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push(r); }
  const samples = Object.fromEntries(Object.keys(FACTOR_COLS).map(k => [k, []]));
  for (const [date, dayRows] of byDate) {
    const rets = [], per = Object.fromEntries(Object.keys(FACTOR_COLS).map(k => [k, []]));
    for (const r of dayRows) {
      const s = seriesBySymbol[r.symbol];
      const i = s ? s.findIndex(b => b.date === date) : -1;
      if (i < 0 || i + horizon >= s.length) continue;
      const c0 = s[i].close, c1 = s[i + horizon].close;
      if (!(c0 > 0) || c1 == null) continue;
      rets.push(c1 / c0 - 1);
      for (const k of Object.keys(FACTOR_COLS)) per[k].push(r[FACTOR_COLS[k]] ?? 50);
    }
    if (rets.length < 3) continue;
    for (const k of Object.keys(FACTOR_COLS)) { const ic = spearman(per[k], rets); if (ic != null) samples[k].push(ic); }
  }
  const out = {};
  for (const k of Object.keys(FACTOR_COLS)) {
    const a = samples[k];
    const m = a.length ? mean(a) : null;
    const sd = a.length > 1 ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)) : null;
    out[k] = { meanIC: m == null ? null : +m.toFixed(3), tStat: m != null && sd ? +(m / (sd / Math.sqrt(a.length))).toFixed(2) : null, dates: a.length };
  }
  return out;
}

const badge = (name, rowsPresented, emissions, { source = 'recorded' } = {}) => {
  const meta = signalMeta(name);
  const dates = [...new Set(emissions.map(e => e.date))];
  return {
    signal: name, label: meta?.label || name, description: meta?.description || null, source, market: 'US',
    firings: emissions.length, symbols: new Set(emissions.map(e => e.symbol)).size,
    firstFired: dates[0] || null, lastFired: dates[dates.length - 1] || null,
    horizons: rowsPresented,
    headline: emissions.length ? headline(rowsPresented, { source, benchmarkLabel: BENCHMARK }) : { state: 'no-data', text: 'No snapshots recorded yet', detail: 'The track record starts accumulating from the first daily snapshot.' },
  };
};

async function runUsPicksScorecard({ fetchRows = defaultFetch, context = buildUsMarketContext } = {}) {
  const rows = await fetchRows();
  if (!rows.length) {
    return {
      params: { horizons: HORIZONS, benchmark: BENCHMARK, minN: MIN_N },
      period: null, overall: [], top10: [], factorIC: null,
      signals: [badge('us_picks_top25', [], []), badge('us_picks_top10', [], [])],
      caveats: ['No snapshots recorded yet — the track record starts accumulating from the first daily snapshot.'],
      generatedAt: new Date().toISOString(),
    };
  }
  const firstDate = rows[0].date;
  const symbols = [...new Set(rows.map(r => r.symbol))];
  const ctx = await context(symbols, firstDate);
  const opts = { horizons: HORIZONS, benchmark: ctx.benchmark };
  const overall = present(scoreSignal(rows, ctx.seriesBySymbol, opts));
  const top10Rows = rows.filter(r => r.rank <= 10);
  const top10 = present(scoreSignal(top10Rows, ctx.seriesBySymbol, opts));
  const dates = [...new Set(rows.map(r => r.date))];
  return {
    params: { horizons: HORIZONS, benchmark: BENCHMARK, minN: MIN_N, topSlice: 10 },
    period: { first: firstDate, last: dates[dates.length - 1], snapshotDays: dates.length, emissions: rows.length },
    calendarGaps: ctx.calendarGaps,
    overall, top10,
    factorIC: factorICFromRows(rows, ctx.seriesBySymbol, 10),
    signals: [badge('us_picks_top25', overall, rows), badge('us_picks_top10', top10, top10Rows)],
    caveats: [
      'Only picks actually written to us_pick_snapshots — no reconstruction, no lookahead.',
      'Emissions overlap heavily day to day (a pick usually stays in the top 25), so n overstates the independent evidence.',
      'Entry at the snapshot-date close; costs and slippage are not modeled.',
      'Excess is over SPY; the backtest measures excess over the universe median as well.',
      'Factor IC is measured inside the recorded top 25 only, where every percentile is already high — a weak test, and the only one EPS revisions can ever get.',
      'Recent snapshots have not had time to resolve at the longer horizons; they are counted in `unresolved`, never as flat.',
    ],
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runUsPicksScorecard, factorICFromRows, HORIZONS };
```

- [ ] **Step 5: Run tests**

Run: `cd backend && node --test usPicks/scorecard.test.js`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/signals/usMarketSeries.js backend/usPicks/scorecard.js backend/usPicks/scorecard.test.js
git commit -m "usPicks: scorecard of recorded picks vs SPY, with per-factor IC from recorded percentiles

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Backtest

**Files:**
- Create: `backend/usPicks/backtest.js`, `backend/usPicks/backtest.test.js`

**Interfaces:**
- Consumes: `loadInputs`, `buildUniverseFrom`, `rankUniverse`, `BACKTEST_WEIGHTS`, `indexAsOf` (Task 5).
- Produces: `runUsBacktest({ from = '2015-01-01', step = 5, topN = 25, horizons = [5, 10, 22], inputs = null } = {})` → `{ params, period, summary: [{ horizon, evalDates, meanExcessVsMedianPct, meanExcessVsSpyPct, hitRatePct, top10ExcessVsSpyPct, quintileMeansPct }], ics, sweep: [{ momentum: {window, skip}, horizon: '10d', meanExcessVsSpyPct, icComposite, tStat }], caveats, generatedAt }`; pure `evaluateAt(inputs, { asOf, momentum, horizons, topN, weights })`.

- [ ] **Step 1: Write the failing test**

```js
// backend/usPicks/backtest.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAt, evalIndices } = require('./backtest');

const day = (i) => { const d = new Date(Date.UTC(2020, 0, 1)); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); };
const bars = (n, from, step) => Array.from({ length: n }, (_, i) => { const c = from + i * step; return { date: day(i), open: c, high: c, low: c, close: c, volume: 1e6 }; });
const inputs = () => ({
  members: Array.from({ length: 60 }, (_, k) => ({ symbol: `S${k}`, name: `S${k}`, sector: null })),
  // S0 climbs fastest, S59 slowest — momentum should order them.
  barsBySymbol: Object.fromEntries(Array.from({ length: 60 }, (_, k) => [`S${k}`, bars(400, 100, 0.5 - k * 0.005)])),
  spyBars: bars(400, 400, 0.1),
  earningsBySymbol: new Map(), revisionsBySymbol: new Map(), revisionsMissing: 0, macroLabel: null,
});

describe('evalIndices', () => {
  test('steps along the SPY calendar and leaves room for the horizon', () => {
    const idx = evalIndices(bars(30, 1, 1), { from: day(0), step: 5, minWarm: 10, maxHorizon: 5 });
    assert.deepEqual(idx, [10, 15, 20]);
  });
});

describe('evaluateAt', () => {
  test('scores the top picks against the universe median and SPY, causally', () => {
    const r = evaluateAt(inputs(), { asOf: day(300), horizons: [5, 10], topN: 10 });
    assert.equal(r.evalDate, day(300));
    assert.ok(r.horizons[10].scored >= 50);
    assert.ok(r.horizons[10].excessVsMedian > 0, 'fastest climbers rank first and beat the median');
    assert.equal(typeof r.horizons[10].excessVsSpy, 'number');
    assert.equal(r.horizons[10].quintiles.length, 5);
    assert.ok(r.icComposite > 0.9);
  });
  test('a later bar cannot change an earlier evaluation', () => {
    const a = evaluateAt(inputs(), { asOf: day(300), horizons: [5], topN: 10 });
    const inp = inputs();
    for (const k of Object.keys(inp.barsBySymbol)) inp.barsBySymbol[k] = inp.barsBySymbol[k].slice(0, 306);
    inp.spyBars = inp.spyBars.slice(0, 306);
    const b = evaluateAt(inp, { asOf: day(300), horizons: [5], topN: 10 });
    assert.deepEqual(a.top.map(t => t.symbol), b.top.map(t => t.symbol));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test usPicks/backtest.test.js`
Expected: FAIL — `Cannot find module './backtest'`

- [ ] **Step 3: Implement `backend/usPicks/backtest.js`**

```js
// ─── US picks backtest — is the factor model any good? ───────────────────────
//
// Re-runs the engine's own factor maths at every 5th SPY session from 2015 and
// measures what the default-weight top picks did next. Same functions the live
// engine uses, imported not copied (volumeThrustStudy rule 3) — so this
// evaluates the rule that ships.
//
// What it can and cannot say, stated up front because the numbers will be
// quoted without the caveats:
//
//   · It scores the FOUR price factors. EPS revisions has no vintage history
//     and gets weight 0 here (BACKTEST_WEIGHTS). The live composite differs.
//   · Excess is reported two ways — over the universe median ("did the picks
//     beat the average stock") and over SPY ("did holding them beat the index").
//     They disagree; both are legitimate; neither is blended into the other.
//   · The momentum window is swept. 20/5 shipped for parity with India, not
//     because it is best here; the grid says which it is.
//   · The universe is TODAY'S members. Delisted losers are absent, which
//     flatters every long-horizon US backtest, this one included.
//
// Where this and usPicks/scorecard.js disagree, the scorecard is the honest
// number. It measures rows that were written before the outcome existed.

const { loadInputs, buildUniverseFrom, rankUniverse, BACKTEST_WEIGHTS, indexAsOf } = require('./engine');

const HISTORY_FROM = '2015-01-01';
const HORIZONS = [5, 10, 22];
const MIN_SCORED = 50;   // fewer priced names than this on a date = too thin to score
const WARM_BARS = 260;   // 252 for the 52-week window, plus slack
const SWEEP = [{ window: 20, skip: 5 }, { window: 60, skip: 5 }, { window: 120, skip: 20 }, { window: 252, skip: 21 }];

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
function midRanks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const r = (i + j) / 2 + 1; for (let k = i; k <= j; k++) ranks[idx[k][1]] = r; i = j + 1; }
  return ranks;
}
function spearman(xs, ys) {
  const n = xs.length; if (n < 3) return null;
  const rx = midRanks(xs), ry = midRanks(ys), mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}
const tOfMean = (a) => { const m = mean(a); if (a.length < 2 || m == null) return null; const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); return sd ? +(m / (sd / Math.sqrt(a.length))).toFixed(2) : null; };

/** Indices into spyBars to evaluate at: every `step` bars once warm, leaving room for the longest horizon. */
function evalIndices(spyBars, { from, step, minWarm, maxHorizon }) {
  const out = [];
  for (let i = minWarm; i + maxHorizon < spyBars.length; i += step) if (spyBars[i].date >= from) out.push(i);
  return out;
}

/** Forward return of `symbol` from the bar on `date` to `h` SPY sessions later. */
function forwardFrom(bars, dateIdxOnSpy, spyBars, h) {
  const d0 = spyBars[dateIdxOnSpy]?.date, d1 = spyBars[dateIdxOnSpy + h]?.date;
  if (!d0 || !d1) return null;
  const i0 = indexAsOf(bars, d0), i1 = indexAsOf(bars, d1);
  if (i0 < 0 || i1 < 0 || bars[i0].date !== d0 || bars[i1].date !== d1) return null;
  const c0 = bars[i0].close, c1 = bars[i1].close;
  return c0 > 0 ? c1 / c0 - 1 : null;
}

/** One evaluation date: rank on bars ≤ asOf, then look forward. Pure. */
function evaluateAt(inputs, { asOf, momentum = {}, horizons = HORIZONS, topN = 25, weights = BACKTEST_WEIGHTS }) {
  const universe = buildUniverseFrom(inputs, { asOf, momentum });
  const ranked = rankUniverse(universe.stocks, weights);
  const spyIdx = indexAsOf(inputs.spyBars, asOf);
  const out = { evalDate: universe.period.snapshotDate, universe: ranked.length, horizons: {}, icComposite: null, icByFactor: null, top: ranked.slice(0, topN).map(r => ({ symbol: r.symbol, composite: r.composite })) };

  for (const h of horizons) {
    const spyRet = forwardFrom(inputs.spyBars, spyIdx, inputs.spyBars, h);
    const rows = [];
    for (const s of ranked) {
      const ret = forwardFrom(inputs.barsBySymbol[s.symbol], spyIdx, inputs.spyBars, h);
      if (ret == null) continue;
      rows.push({ rank: s.rank, composite: s.composite, pct: s.pct, ret });
    }
    if (rows.length < MIN_SCORED) continue;
    const uniMedian = median(rows.map(r => r.ret));
    const top = rows.filter(r => r.rank <= topN);
    const top10 = rows.filter(r => r.rank <= 10);
    if (!top.length) continue;
    const sorted = [...rows].sort((a, b) => a.rank - b.rank);
    const q = Math.floor(sorted.length / 5) || 1;
    const quintiles = [[], [], [], [], []];
    sorted.forEach((r, k) => quintiles[Math.min(4, Math.floor(k / q))].push(r.ret));
    out.horizons[h] = {
      scored: rows.length, picks: top.length,
      topMean: mean(top.map(r => r.ret)), top10Mean: top10.length ? mean(top10.map(r => r.ret)) : null,
      uniMedian, spyRet,
      excessVsMedian: mean(top.map(r => r.ret)) - uniMedian,
      excessVsSpy: spyRet == null ? null : mean(top.map(r => r.ret)) - spyRet,
      top10ExcessVsSpy: spyRet == null || !top10.length ? null : mean(top10.map(r => r.ret)) - spyRet,
      hits: top.filter(r => r.ret > uniMedian).length,
      quintiles: quintiles.map(x => (x.length ? mean(x) : null)),
    };
    if (h === 10) {
      out.icComposite = spearman(rows.map(r => r.composite), rows.map(r => r.ret));
      out.icByFactor = Object.fromEntries(['momentum', 'volume', 'fiftyTwo', 'relStrength'].map(f => [f, spearman(rows.map(r => r.pct[f]), rows.map(r => r.ret))]));
    }
  }
  return out;
}

async function runUsBacktest({ from = HISTORY_FROM, step = 5, topN = 25, horizons = HORIZONS, inputs = null } = {}) {
  const inp = inputs || await loadInputs({ from, includeRevisions: false, includeEarnings: false });
  const idxs = evalIndices(inp.spyBars, { from, step, minWarm: WARM_BARS, maxHorizon: Math.min(...horizons) });
  if (!idxs.length) throw new Error('Not enough history to evaluate');

  const perDate = [];
  for (const i of idxs) perDate.push(evaluateAt(inp, { asOf: inp.spyBars[i].date, horizons, topN }));

  const pct = (v) => (v == null ? null : +(v * 100).toFixed(2));
  const summary = horizons.map(h => {
    const ds = perDate.filter(d => d.horizons[h]);
    const exM = ds.map(d => d.horizons[h].excessVsMedian);
    const exS = ds.map(d => d.horizons[h].excessVsSpy).filter(v => v != null);
    const ex10 = ds.map(d => d.horizons[h].top10ExcessVsSpy).filter(v => v != null);
    const hits = ds.reduce((s, d) => s + d.horizons[h].hits, 0), total = ds.reduce((s, d) => s + d.horizons[h].picks, 0);
    const quint = [0, 1, 2, 3, 4].map(k => { const xs = ds.map(d => d.horizons[h].quintiles[k]).filter(v => v != null); return pct(mean(xs)); });
    return {
      horizon: h, evalDates: ds.length,
      meanExcessVsMedianPct: pct(mean(exM)), tVsMedian: tOfMean(exM),
      meanExcessVsSpyPct: pct(mean(exS)), tVsSpy: tOfMean(exS),
      top10ExcessVsSpyPct: pct(mean(ex10)),
      hitRatePct: total ? +((hits / total) * 100).toFixed(1) : null, pickObs: total,
      quintileMeansPct: quint,
    };
  });

  const icOf = (pick) => { const a = perDate.map(pick).filter(v => v != null); return { meanIC: a.length ? +mean(a).toFixed(3) : null, tStat: tOfMean(a), dates: a.length }; };
  const ics = [
    ...['momentum', 'volume', 'fiftyTwo', 'relStrength'].map(f => ({ factor: f, ...icOf(d => d.icByFactor?.[f]) })),
    { factor: 'composite', ...icOf(d => d.icComposite) },
  ];

  // The momentum sweep, 10-day horizon, excess over SPY and composite IC.
  const sweep = SWEEP.map(m => {
    const ds = idxs.map(i => evaluateAt(inp, { asOf: inp.spyBars[i].date, momentum: m, horizons: [10], topN }));
    const ex = ds.map(d => d.horizons[10]?.excessVsSpy).filter(v => v != null);
    const ic = ds.map(d => d.icComposite).filter(v => v != null);
    return { momentum: m, horizon: '10d', evalDates: ex.length, meanExcessVsSpyPct: pct(mean(ex)), tStat: tOfMean(ex), icComposite: ic.length ? +mean(ic).toFixed(3) : null, shipped: m.window === 20 && m.skip === 5 };
  });

  return {
    params: { from, step, topN, horizons, weights: BACKTEST_WEIGHTS, benchmark: 'SPY' },
    period: { firstEval: perDate[0].evalDate, lastEval: perDate[perDate.length - 1].evalDate, evalDates: perDate.length, universe: inp.members.length },
    summary, ics, sweep,
    caveats: [
      'Scores the FOUR price factors with EPS revisions at weight 0; the live composite includes revisions at 15. This is the same model with one input unavailable, not a different one.',
      'Survivorship bias: the universe is today\'s index members, so companies that were delisted or dropped never appear. That flatters every long-horizon US backtest, this one included.',
      'Evaluation dates are a week apart and picks overlap between them, so n overstates the independent evidence.',
      'Entry at the evaluation-date close; costs, slippage and liquidity are not modeled.',
      'Earnings and red-flag exclusions cannot be reconstructed for past dates, so the backtest universe is slightly wider than the live one.',
      'Where this and the scorecard disagree, the scorecard is the honest number.',
    ],
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runUsBacktest, evaluateAt, evalIndices, SWEEP, HISTORY_FROM };

if (require.main === module) {
  require('dotenv').config({ path: __dirname + '/../../.env' });
  runUsBacktest().then(out => {
    console.log(`${out.period.evalDates} evaluation dates, ${out.period.firstEval} → ${out.period.lastEval}, universe ${out.period.universe}\n`);
    for (const s of out.summary) console.log(`${String(s.horizon).padStart(2)}d  top25 vs median ${s.meanExcessVsMedianPct}% (t=${s.tVsMedian})   vs SPY ${s.meanExcessVsSpyPct}% (t=${s.tVsSpy})   top10 vs SPY ${s.top10ExcessVsSpyPct}%   hit ${s.hitRatePct}%   Q1…Q5 ${s.quintileMeansPct.join(' / ')}`);
    console.log('\nIC (10d):'); for (const i of out.ics) console.log(`  ${i.factor.padEnd(12)} ${i.meanIC}  t=${i.tStat}  n=${i.dates}`);
    console.log('\nMomentum sweep (10d, vs SPY):'); for (const s of out.sweep) console.log(`  ${s.momentum.window}/${s.momentum.skip}${s.shipped ? ' ←shipped' : ''}  ${s.meanExcessVsSpyPct}% (t=${s.tStat})  IC ${s.icComposite}`);
    console.log(''); for (const c of out.caveats) console.log(`· ${c}`);
  }).catch(e => { console.error(e.message); process.exit(1); });
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && node --test usPicks/backtest.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the real backtest once and keep the output**

Run: `cd backend && node usPicks/backtest.js | tee ../docs/superpowers/specs/2026-09-03-us-quant-picks-backtest.txt`
Expected: ~570 evaluation dates 2016→2026. Takes a few minutes (one multi-symbol fetch, then pure maths). Read the momentum sweep: if a window other than 20/5 is clearly stronger (higher t, higher IC, consistent), **stop and report to the user before Task 9** — switching the default after the first snapshot changes what the recorded series means.

- [ ] **Step 6: Commit**

```bash
git add backend/usPicks/backtest.js backend/usPicks/backtest.test.js docs/superpowers/specs/2026-09-03-us-quant-picks-backtest.txt
git commit -m "usPicks: backtest — weekly re-evaluation 2015→today, sweep of the momentum window

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Router, AI brief, daily job

**Files:**
- Create: `backend/usPicks/summary.js`, `backend/usPicks/routes.js`
- Modify: `backend/server.js:5952` (mount before `/api/us`), `backend/dailyJobs.js` (US step + `usSnapshotDue`), `backend/dailyJobs.test.js`

**Interfaces:**
- Produces: routes `GET /api/us/stock-picks` (universe, 30-min cache), `GET /history?days=45`, `GET /scorecard` (1h cache), `GET /backtest` (6h cache, `?force=1`), `POST /summary`, `POST /snapshot`; `usSnapshotDue(spyLastDate, snapLast, now = new Date()) → boolean`; `runUsPickSnapshot()`.

- [ ] **Step 1: Write the failing test** — append to `backend/dailyJobs.test.js`:

```js
const { usSnapshotDue } = require('./dailyJobs');

describe('usSnapshotDue', () => {
  test('due once the SPY session has closed and nothing is recorded for it', () => {
    assert.equal(usSnapshotDue('2026-09-03', '2026-09-02', new Date('2026-09-03T21:30:00Z')), true);
  });
  test('not due while the session is still open', () => {
    assert.equal(usSnapshotDue('2026-09-03', '2026-09-02', new Date('2026-09-03T18:00:00Z')), false);
  });
  test('a bar from a previous day is closed regardless of the clock', () => {
    assert.equal(usSnapshotDue('2026-09-02', '2026-09-01', new Date('2026-09-03T10:00:00Z')), true);
  });
  test('not due when already recorded', () => {
    assert.equal(usSnapshotDue('2026-09-03', '2026-09-03', new Date('2026-09-03T23:00:00Z')), false);
  });
  test('not due with no SPY bar', () => {
    assert.equal(usSnapshotDue(null, null), false);
  });
});
```

(Check the top of `dailyJobs.test.js` already imports `test`, `describe`, `assert`; add them if not.)

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test dailyJobs.test.js`
Expected: FAIL — `usSnapshotDue is not a function`

- [ ] **Step 3: `backend/usPicks/summary.js`**

```js
// ─── AI brief — narrates the already-ranked US output (Groq) ─────────────────
// The model never picks. It explains rows a deterministic engine produced.
const { llm, withTimeout, contentToString } = require('../ai/sqlAgent');

const US_PICKS_SYSTEM_PROMPT = `You are a quantitative equity analyst writing a brief on an ALREADY-COMPUTED, deterministic stock ranking for the US market (S&P 500 and Nasdaq 100). You did NOT choose these stocks — a transparent factor model did (momentum = 20-session return skipping the latest week; volume conviction vs the stock's own baseline with a Volume Authenticity guard; 52-week strength; relative strength vs SPY over ~3 months; EPS estimate revisions). Names reporting earnings within 5 sessions, illiquid names, and pump-and-fade patterns are already excluded. Your job is ONLY to explain the output, not to change it.

Rules:
- Do NOT invent tickers, re-rank, or add/remove names. Use ONLY the provided rows.
- Do NOT give buy/sell/hold advice, entry/exit levels, or price targets.
- Lead with a one-line regime read from the breadth and macro label provided.
- For the top names, state which factor(s) drove the rank, citing the given numbers.
- Explicitly call out any name flagged with trap_risk (low volume authenticity) as a caution.
- Explicitly call out amber flags (fading volume, gap-and-fade, quiet volume spikes) and any imminent earnings date.
- Say when revisions are missing for a name (it was ranked neutral on that factor).
- Note risks/caveats (crowded momentum, sector concentration, short period).
- Be concise: a short regime paragraph, then a tight bulleted list. Markdown.
- End with exactly: "Deterministic factor summary for research only — not investment advice."`;

async function generateUsPicksSummary({ period, regime, weights, picks }) {
  const user = [
    `Snapshot date: ${period.snapshotDate}.`,
    `Regime: ${regime.label}.`,
    `Active factor weights: ${JSON.stringify(weights)}.`,
    `Top ranked stocks (composite + factor breakdown):`,
    JSON.stringify(picks, null, 2),
    `Write the brief.`,
  ].join('\n\n');
  const resp = await withTimeout(llm.invoke([
    { role: 'system', content: US_PICKS_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]), 30000, 'US picks summary');
  return contentToString(resp.content).trim();
}

module.exports = { generateUsPicksSummary, US_PICKS_SYSTEM_PROMPT };
```

- [ ] **Step 4: `backend/usPicks/routes.js`**

```js
// ─── /api/us/stock-picks/* ───────────────────────────────────────────────────
// Thin. Every number comes from engine.js / scorecard.js / backtest.js; this
// file only caches and shapes HTTP. Mounted in server.js BEFORE the /api/us
// router so the more specific prefix wins.

const express = require('express');
const { buildUsFactorUniverse, fetchSnapshotHistory, saveDailySnapshot, DEFAULT_WEIGHTS } = require('./engine');
const { runUsPicksScorecard } = require('./scorecard');
const { runUsBacktest } = require('./backtest');
const { generateUsPicksSummary } = require('./summary');

const router = express.Router();

const UNIVERSE_TTL = 30 * 60 * 1000;
const SCORECARD_TTL = 60 * 60 * 1000;
const BACKTEST_TTL = 6 * 60 * 60 * 1000;
let universeCache = null, scorecardCache = null, backtestCache = null;
let universeInflight = null, backtestInflight = null;

const missingTable = (err) => /does not exist|schema cache/i.test(err.message);
const isoMinus = (days) => { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); };

router.get('/', async (req, res) => {
  if (universeCache && Date.now() - universeCache.ts < UNIVERSE_TTL) return res.json({ ...universeCache.data, cached: true });
  try {
    if (!universeInflight) universeInflight = buildUsFactorUniverse().finally(() => { universeInflight = null; });
    const data = await universeInflight;
    universeCache = { data, ts: Date.now() };
    res.json({ ...data, defaultWeights: DEFAULT_WEIGHTS });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, configured: !err.notConfigured });
  }
});

router.get('/history', async (req, res) => {
  const days = Math.min(120, Math.max(2, parseInt(req.query.days, 10) || 45));
  try {
    res.json({ available: true, dates: await fetchSnapshotHistory(isoMinus(days)) });
  } catch (err) {
    if (missingTable(err)) return res.json({ available: false, hint: 'Run `node backend/migrate_us_pick_snapshots.js` and paste the SQL into the Supabase SQL editor to enable US pick history.' });
    res.status(500).json({ error: err.message });
  }
});

router.get('/scorecard', async (req, res) => {
  if (scorecardCache && Date.now() - scorecardCache.ts < SCORECARD_TTL) return res.json({ ...scorecardCache.data, cached: true });
  try {
    const data = await runUsPicksScorecard();
    scorecardCache = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    if (missingTable(err)) return res.json({ available: false, signals: [], hint: 'us_pick_snapshots does not exist yet — run migrate_us_pick_snapshots.js.' });
    res.status(500).json({ error: err.message });
  }
});

router.get('/backtest', async (req, res) => {
  try {
    if (!req.query.force && backtestCache && Date.now() - backtestCache.ts < BACKTEST_TTL) return res.json({ ...backtestCache.data, cached: true });
    if (!backtestInflight) backtestInflight = runUsBacktest().finally(() => { backtestInflight = null; });
    const data = await backtestInflight;
    backtestCache = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/summary', async (req, res) => {
  const { period, regime, weights, picks } = req.body || {};
  if (!period || !regime || !Array.isArray(picks) || picks.length === 0) {
    return res.status(400).json({ error: 'period, regime and a non-empty picks array are required' });
  }
  try {
    res.json({ summary: await generateUsPicksSummary({ period, regime, weights: weights || DEFAULT_WEIGHTS, picks: picks.slice(0, 25) }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Manual trigger; the scheduled path is dailyJobs.runUsPickSnapshot. */
router.post('/snapshot', async (req, res) => {
  try {
    const universe = await buildUsFactorUniverse();
    res.json(await saveDailySnapshot(universe));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { usPicksRouter: router };
```

- [ ] **Step 5: Mount in `backend/server.js`** — immediately before `app.use('/api/us', alpacaRouter);`:

```js
// US quant picks. Mounted before /api/us so its prefix wins the match.
const { usPicksRouter } = require('./usPicks/routes');
app.use('/api/us/stock-picks', usPicksRouter);
```

- [ ] **Step 6: Daily job** — in `backend/dailyJobs.js`:

Add after `snapshotIsDue`:

```js
/**
 * Is a US picks snapshot due?
 *
 * The SPY bar is the trigger, not a clock. It is due when the newest SPY daily
 * bar is newer than the newest snapshot AND that session has closed — the bar
 * is from a previous UTC day, or it is today and the clock is past 21:00 UTC
 * (16:00 ET plus settlement, in either DST regime). Before that Alpaca serves
 * a partial bar and a snapshot taken from it would record prices nobody could
 * have closed at.
 */
function usSnapshotDue(spyLast, snapLast, now = new Date()) {
  if (!spyLast) return false;
  if (snapLast && snapLast >= spyLast) return false;
  const todayUtc = now.toISOString().slice(0, 10);
  if (spyLast < todayUtc) return true;
  return now.getUTCHours() >= 21;
}

async function runUsPickSnapshot() {
  const { fetchBarsMulti } = require('./alpacaData');
  const start = new Date(); start.setDate(start.getDate() - 10);
  const spy = (await fetchBarsMulti(['SPY'], start)).SPY || [];
  const spyLast = spy.length ? String(spy[spy.length - 1].date).slice(0, 10) : null;
  const snapLast = await latestDate('us_pick_snapshots', 'snap_date');
  if (!usSnapshotDue(spyLast, snapLast)) return { skipped: 'not due', spyLast, snapLast };
  const { buildUsFactorUniverse, saveDailySnapshot } = require('./usPicks/engine');
  const universe = await buildUsFactorUniverse();
  const r = await saveDailySnapshot(universe);
  return { ...r, spyLast, was: snapLast };
}
```

In `runDailyJobs`, add `usPicks: null` to `out`, and after the macro block (before `return out;`):

```js
  // US picks. Same standard as the Indian snapshot — written before the
  // outcome exists, completion decided by the table. Fails softly when the
  // table has not been migrated or Alpaca is not configured.
  try {
    const r = await runUsPickSnapshot();
    out.usPicks = r;
    if (r?.saved) console.log(`[daily] US picks snapshot ${r.snapDate}: ${r.saved} rows`);
  } catch (err) {
    out.usPicks = { error: err.message };
    console.warn('[daily] US picks snapshot failed (will retry next tick):', err.message);
  }
```

Add `usSnapshotDue, runUsPickSnapshot` to `module.exports`.

- [ ] **Step 7: Run tests and a route smoke**

Run: `cd backend && node --test dailyJobs.test.js && node -e "require('./usPicks/routes'); require('./server.js')" & sleep 8; curl -s "http://localhost:3001/api/us/stock-picks/scorecard" | head -c 300; echo; curl -s "http://localhost:3001/api/us/stock-picks" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.period, j.regime?.label, j.universeSize)})"; pkill -f "node server.js"`
Expected: tests PASS; scorecard returns `available:false` (table not yet created) or an empty-signals shape; universe returns a period, regime line and a size ~500+.

- [ ] **Step 8: Commit**

```bash
git add backend/usPicks/summary.js backend/usPicks/routes.js backend/server.js backend/dailyJobs.js backend/dailyJobs.test.js
git commit -m "US picks: router, AI brief, daily snapshot keyed to the SPY bar

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Shared ranking helper on the frontend

**Files:**
- Create: `frontend/src/lib/picksRank.js`, `frontend/src/lib/picksRank.test.js`
- Modify: `frontend/src/pages/marketData/StockPicks.jsx:40-56` (delete inline `percentileRanks`, import it)

**Interfaces:**
- Produces: `percentileRanks(values)` (null → 50), `rankRows(stocks, factors, weights)` where `factors = [{ key, raw }]` → rows with `pct`, `composite`, `rank`.

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/lib/picksRank.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { percentileRanks, rankRows } from './picksRank.js'

// The Indian page's inline copy, verbatim, so the move is provably a no-op.
function indiaPercentileRanks(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  return values.map(v => {
    let lo = 0, hi = n
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid }
    const first = lo
    hi = n
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid + 1; else hi = mid }
    return n ? ((first + lo) / 2 / n) * 100 : 0
  })
}

describe('percentileRanks', () => {
  test('matches the Indian page on every non-null input', () => {
    const cases = [[0, 0, 0, 5], [3, 1, 2], [1, 1, 1], [], [-2, 0, 2, 2, 9]]
    for (const c of cases) assert.deepEqual(percentileRanks(c), indiaPercentileRanks(c))
  })
  test('nulls land at exactly 50 and do not shift the rest', () => {
    assert.deepEqual(percentileRanks([1, null, 3]), [25, 50, 75])
  })
})

describe('rankRows', () => {
  test('weights, sorts, and numbers from 1', () => {
    const stocks = [
      { symbol: 'A', factors: { m: 3, v: 0 } },
      { symbol: 'B', factors: { m: 1, v: 9 } },
    ]
    const rows = rankRows(stocks, [{ key: 'mom', raw: 'm' }, { key: 'vol', raw: 'v' }], { mom: 100, vol: 0 })
    assert.deepEqual(rows.map(r => r.symbol), ['A', 'B'])
    assert.deepEqual(rows.map(r => r.rank), [1, 2])
    assert.equal(rows[0].composite, 75)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test 2>&1 | tail -5`
Expected: FAIL — cannot find `./picksRank.js`

- [ ] **Step 3: Implement `frontend/src/lib/picksRank.js`**

```js
// ─── Ranking maths shared by the Indian and US quant-picks pages ─────────────
// Mid-rank percentile (0–100) of each value within the array. Ties share the
// MIDDLE of their block — most stocks sit at 0 on any given factor (e.g. no
// large deals), and max-rank ties would reward having no data at all.
//
// `null` means "no data" and lands at exactly 50 — a missing EPS revision is
// not a bad revision. The Indian page pre-fills `?? 0` before calling this, so
// its output is unchanged by the move (see picksRank.test.js).
export function percentileRanks(values) {
  const known = values.filter(v => v != null)
  const sorted = [...known].sort((a, b) => a - b)
  const n = sorted.length
  return values.map(v => {
    if (v == null) return 50
    let lo = 0, hi = n
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid }
    const first = lo // count of values < v
    hi = n
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid + 1; else hi = mid }
    return n ? ((first + lo) / 2 / n) * 100 : 0 // lo = count of values <= v
  })
}

/** Percentile each factor, blend by normalised weights, sort, number from 1. */
export function rankRows(stocks, factors, weights) {
  const cols = {}
  for (const f of factors) cols[f.key] = percentileRanks(stocks.map(s => s.factors[f.raw]))
  const sumW = factors.reduce((a, f) => a + (weights[f.key] || 0), 0) || 1
  const rows = stocks.map((s, i) => {
    const pct = {}; let composite = 0
    for (const f of factors) { pct[f.key] = cols[f.key][i]; composite += ((weights[f.key] || 0) / sumW) * pct[f.key] }
    return { ...s, pct, composite }
  })
  rows.sort((a, b) => b.composite - a.composite)
  return rows.map((r, i) => ({ ...r, rank: i + 1 }))
}
```

- [ ] **Step 4: Point the Indian page at it**

In `frontend/src/pages/marketData/StockPicks.jsx`: delete the inline `percentileRanks` function (lines 40–56, keep its comment block's first two lines moved into the lib), add `import { percentileRanks } from '../../lib/picksRank'`. The call site `percentileRanks(stocks.map(s => s.factors[f.raw] ?? 0))` stays exactly as it is — the `?? 0` is what keeps India's behaviour identical.

- [ ] **Step 5: Run tests and build**

Run: `cd frontend && npm test 2>&1 | tail -4 && npx vite build 2>&1 | grep -E "built in|error"`
Expected: all PASS, `✓ built`

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/picksRank.js frontend/src/lib/picksRank.test.js frontend/src/pages/marketData/StockPicks.jsx
git commit -m "picksRank: one percentile-ranking helper for both picks pages

Parity test against the Indian page's inline copy before it is removed.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Badges that know which market scored them

**Files:**
- Modify: `frontend/src/lib/useSignalScore.js`, `frontend/src/components/SignalScore.jsx`

**Interfaces:**
- Produces: `loadScorecard(market = 'IN')`, `useSignalScore(signal, { source, market = 'IN' })`; `<SignalScore market="US" signal="us_picks_top25" />` renders the US headline; any other US signal keeps the "not measured here" badge.

- [ ] **Step 1: `useSignalScore.js`** — replace the cache and loader:

```js
// One fetch per market per page load. India's scorecard and the US one are
// different endpoints measured on different prices; keeping them in one cache
// would let a badge read the wrong market's numbers.
const ENDPOINT = { IN: '/api/signals/scorecard', US: '/api/us/stock-picks/scorecard' }
const cache = {}
const inflight = {}

export function loadScorecard(market = 'IN') {
  const url = ENDPOINT[market] || ENDPOINT.IN
  if (cache[url]) return Promise.resolve(cache[url])
  if (!inflight[url]) {
    inflight[url] = fetch(url)
      .then(async r => {
        const j = await r.json()
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
        cache[url] = j
        return j
      })
      .finally(() => { delete inflight[url] })
  }
  return inflight[url]
}

export function useSignalScore(signalName, { source, market = 'IN' } = {}) {
  const [state, setState] = useState({ entry: null, error: null, loading: true })
  useEffect(() => {
    let on = true
    loadScorecard(market)
      .then(j => {
        if (!on) return
        const matches = (j.signals || []).filter(s => s.signal === signalName)
        const entry = (source && matches.find(s => s.source === source))
          || matches.find(s => s.source === 'recorded')
          || matches[0]
          || null
        setState({ entry, error: null, loading: false })
      })
      .catch(e => { if (on) setState({ entry: null, error: e.message, loading: false }) })
    return () => { on = false }
  }, [signalName, source, market])
  return state
}
```

- [ ] **Step 2: `SignalScore.jsx`** — change the hook call and the US branch:

```js
export default function SignalScore({ signal, label, source, style, market = 'IN' }) {
  const { entry, error, loading } = useSignalScore(signal, { source, market })

  // Off the Indian market, only a signal the US scorecard actually carries has
  // a record. Everything else keeps the explicitly empty badge — a US chart
  // must never borrow a number measured on Indian prices.
  if (market !== 'IN') {
    if (loading) return null
    if (!entry) return <Badge tone={TONE.unscoreable} label={label} headline={NO_RECORD} style={style} />
  } else {
    if (loading) return null
    if (error || !entry) return null
  }
```

Keep the rest of the component (detail assembly, `Badge`) unchanged. Update the `NO_RECORD.detail` first sentence to: `'The India scorecard is built from nse_bhavcopy and scored against NIFTY 50; the US scorecard covers only the US quant picks. This signal is in neither, so there is nothing to show.'` followed by the existing pointer to the two studies.

- [ ] **Step 3: Build**

Run: `cd frontend && npx vite build 2>&1 | grep -E "built in|error"`
Expected: `✓ built`

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/useSignalScore.js frontend/src/components/SignalScore.jsx
git commit -m "SignalScore: a US-scored signal reads the US scorecard; others stay unmeasured

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: The page, route and nav

**Files:**
- Create: `frontend/src/pages/us/UsStockPicks.jsx`
- Modify: `frontend/src/App.jsx` (import + route before `/us/:symbol`), `frontend/src/components/Navbar.jsx` (`US_LINKS`, and the `active` exclusion list)

**Interfaces:**
- Consumes: `GET /api/us/stock-picks`, `/history`, `/backtest`, `POST /summary` (Task 9); `rankRows` (Task 10); `<SignalScore market="US">` (Task 11).

- [ ] **Step 1: Write `frontend/src/pages/us/UsStockPicks.jsx`**

```jsx
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import SignalScore from '../../components/SignalScore'
import { rankRows } from '../../lib/picksRank'

// ─── US Quant Stock Picks ────────────────────────────────────────────────────
// The Indian page's shape with this market's inputs. Raw factors come from
// /api/us/stock-picks; ranking is done here so sliders re-rank instantly. The
// recorded series (default weights, traps excluded) is what the badges score —
// nothing a slider does touches it.

const FACTORS = [
  { key: 'momentum',    raw: 'momentumRaw',    label: 'Momentum',      color: '#38bdf8', help: '20-session return skipping the latest 5 (short-term reversal adjusted). Same definition as the Indian page.' },
  { key: 'volume',      raw: 'volumeRaw',      label: 'Volume',        color: '#a3e635', help: 'Last-5 volume vs the stock\'s own 20-session baseline, scaled by authenticity (price corroboration + persistence). No delivery % exists in the US.' },
  { key: 'fiftyTwo',    raw: 'fiftyTwoRaw',    label: '52-week',       color: '#f59e0b', help: 'Fresh 252-session high (+1) or low (−1) in the last 5 sessions, plus proximity to the high. Adjusted closes.' },
  { key: 'relStrength', raw: 'relStrengthRaw', label: 'Rel. strength', color: '#c084fc', help: '~3-month return minus SPY\'s, in points.' },
  { key: 'revisions',   raw: 'revisionsRaw',   label: 'EPS revisions', color: '#f472b6', help: 'Net analyst EPS revisions over 30 days and the change in the current-year estimate (Yahoo). Missing = ranked neutral. Cannot be backtested — scored forward only.' },
]
const DEFAULT_WEIGHTS = { momentum: 30, volume: 20, fiftyTwo: 15, relStrength: 20, revisions: 15 }
const PRESETS = [
  { name: 'Balanced', weights: DEFAULT_WEIGHTS },
  { name: 'Momentum-heavy', weights: { momentum: 45, volume: 15, fiftyTwo: 15, relStrength: 25, revisions: 0 } },
  { name: 'Revisions-on', weights: { momentum: 25, volume: 15, fiftyTwo: 10, relStrength: 20, revisions: 30 } },
]
const PREFS_KEY = 'usStockPicks.prefs.v1'
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {} } catch { return {} } }

const fmtUsd = (v) => (v == null ? '—' : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`)
const fmtPct = (v, d = 1) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`)

function Chip({ color = 'var(--text-secondary)', title, children }) {
  return <span title={title} style={{ display: 'inline-block', padding: '0.05rem 0.4rem', borderRadius: '4px', border: `1px solid ${color}`, color, fontSize: '0.65rem', fontWeight: 600, marginRight: '0.3rem', whiteSpace: 'nowrap', cursor: title ? 'help' : 'default' }}>{children}</span>
}
function Bar({ pct, color }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}><div style={{ width: 54, height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3 }}><div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3 }} /></div><span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', minWidth: 24 }}>{Math.round(pct)}</span></div>
}

export default function UsStockPicks() {
  const navigate = useNavigate()
  const prefs = useRef(loadPrefs()).current
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [weights, setWeights] = useState({ ...DEFAULT_WEIGHTS, ...(prefs.weights || {}) })
  const [topN, setTopN] = useState([10, 25, 50].includes(prefs.topN) ? prefs.topN : 25)
  const [excludeTraps, setExcludeTraps] = useState(prefs.excludeTraps !== false)
  const [summary, setSummary] = useState(null)
  const [summarizing, setSummarizing] = useState(false)
  const [history, setHistory] = useState(null)
  const [backtest, setBacktest] = useState(null)
  const [backtestOpen, setBacktestOpen] = useState(false)
  const [backtestLoading, setBacktestLoading] = useState(false)
  useEffect(() => { try { localStorage.setItem(PREFS_KEY, JSON.stringify({ weights, topN, excludeTraps })) } catch { /* private mode */ } }, [weights, topN, excludeTraps])

  const load = useCallback(async () => {
    setLoading(true); setError(null); setSummary(null)
    try {
      const r = await fetch('/api/us/stock-picks')
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setData(j)
    } catch (e) { setError(e.message); setData(null) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => { fetch('/api/us/stock-picks/history?days=45').then(r => r.json()).then(setHistory).catch(() => {}) }, [])

  const ranked = useMemo(() => {
    if (!data?.stocks?.length) return []
    const stocks = excludeTraps ? data.stocks.filter(s => !s.factors.trapRisk) : data.stocks
    return rankRows(stocks, FACTORS, weights)
  }, [data, weights, excludeTraps])
  const top = ranked.slice(0, topN)

  // Diff against the newest recorded snapshot: who is new, who dropped.
  const diff = useMemo(() => {
    const latest = history?.dates?.[0]?.picks
    if (!latest) return null
    const prev = new Set(latest.map(p => p.symbol))
    const now = new Set(top.map(r => r.symbol))
    return { date: history.dates[0].date, entered: top.filter(r => !prev.has(r.symbol)).map(r => r.symbol), dropped: latest.filter(p => !now.has(p.symbol)).map(p => p.symbol) }
  }, [history, top])

  const sectorWarn = useMemo(() => {
    if (top.length < 10) return null
    const counts = {}
    for (const r of top) counts[r.sector || 'Unknown'] = (counts[r.sector || 'Unknown'] || 0) + 1
    const [sector, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
    return n / top.length >= 0.4 ? { sector, n } : null
  }, [top])

  const summarize = async () => {
    if (!data || !top.length) return
    setSummarizing(true)
    try {
      const picks = top.map(r => ({
        rank: r.rank, symbol: r.symbol, name: r.name, sector: r.sector, composite: +r.composite.toFixed(1),
        momentum_pct: +r.pct.momentum.toFixed(0), volume_pct: +r.pct.volume.toFixed(0), fifty_two_pct: +r.pct.fiftyTwo.toFixed(0), rel_strength_pct: +r.pct.relStrength.toFixed(0), revisions_pct: +r.pct.revisions.toFixed(0),
        momentum_20_5_pct: r.factors.momentumRaw == null ? null : +(r.factors.momentumRaw * 100).toFixed(1), vol_surge_pct: r.factors.surgePct, authenticity: r.factors.authenticity,
        rel_strength_pts: r.factors.relStrengthRaw, revisions_raw: r.factors.revisionsRaw, new_52w_high: r.factors.newHigh5,
        trap_risk: r.factors.trapRisk, trap_reason: r.factors.trapReason, flags: r.flags.map(f => f.id), earnings_date: r.earningsDate,
      }))
      const r = await fetch('/api/us/stock-picks/summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ period: data.period, regime: data.regime, weights, picks }) })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setSummary(j.summary)
    } catch (e) { setSummary(`_Brief unavailable: ${e.message}_`) } finally { setSummarizing(false) }
  }

  const loadBacktest = async () => {
    setBacktestOpen(o => !o)
    if (backtest || backtestLoading) return
    setBacktestLoading(true)
    try { const r = await fetch('/api/us/stock-picks/backtest'); setBacktest(await r.json()) } catch (e) { setBacktest({ error: e.message }) } finally { setBacktestLoading(false) }
  }

  const th = { textAlign: 'left', padding: '0.45rem 0.5rem', fontSize: '0.7rem', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }
  const td = { padding: '0.4rem 0.5rem', borderBottom: '1px solid rgba(255,255,255,0.04)', verticalAlign: 'middle' }
  const riskOff = data?.regime?.breadth?.label === 'risk-off'

  return (
    <div style={{ maxWidth: '1600px', width: '95%', margin: '0 auto', padding: '1.5rem 1rem' }}>
      <h2 style={{ margin: '0 0 0.25rem' }}>US Quant Stock Picks</h2>
      <p style={{ margin: '0 0 1rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
        S&P 500 + Nasdaq 100, five factors, percentile-ranked, your weights. Deterministic — the AI brief only explains the ranking it is given.
      </p>

      {/* Regime + universe */}
      {data && (
        <div className="glass-panel" style={{ padding: '0.85rem 1.25rem', marginBottom: '1rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center', border: `1px solid ${riskOff ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.25)'}` }}>
          <strong style={{ fontSize: '0.85rem' }}>{data.regime.label}</strong>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }} title="Percent of the ranked universe with positive 20/5 momentum">{data.regime.breadth.pctPositiveMomentum}% positive momentum</span>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>as of {data.period.snapshotDate} · {data.universeSize} ranked</span>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }} title={data.excludedSample.join(', ')}>{data.excludedCount} excluded (illiquid / earnings ≤ 5 sessions / pump-fade)</span>
          {data.revisionsMissing > 0 && <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{data.revisionsMissing} without revisions data (ranked neutral)</span>}
        </div>
      )}

      {/* Controls */}
      <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {FACTORS.map(f => (
            <label key={f.key} title={f.help} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              <span><span style={{ color: f.color }}>■</span> {f.label}: <strong style={{ color: 'var(--text-primary)' }}>{weights[f.key]}</strong></span>
              <input type="range" min="0" max="60" value={weights[f.key]} onChange={e => setWeights(w => ({ ...w, [f.key]: +e.target.value }))} style={{ width: 130, accentColor: f.color }} />
            </label>
          ))}
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {PRESETS.map(p => <button key={p.name} onClick={() => setWeights(p.weights)} style={{ padding: '0.3rem 0.6rem', fontSize: '0.72rem', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>{p.name}</button>)}
          </div>
          <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Show <select value={topN} onChange={e => setTopN(+e.target.value)}>{[10, 25, 50].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
          <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
            <input type="checkbox" checked={excludeTraps} onChange={e => setExcludeTraps(e.target.checked)} /> Hide trap-risk names
          </label>
        </div>
      </div>

      {loading ? <div className="loader" /> : error ? (
        <div className="glass-panel" style={{ padding: '1.5rem', color: '#ef4444' }}>Failed to load: {error}</div>
      ) : !top.length ? (
        <div className="glass-panel" style={{ padding: '1.5rem', color: 'var(--text-secondary)' }}>Nothing to rank.</div>
      ) : (
        <>
          {sectorWarn && <div className="glass-panel" style={{ padding: '0.6rem 1rem', marginBottom: '0.75rem', fontSize: '0.78rem', color: '#fbbf24' }}>⚠ {sectorWarn.n} of {top.length} picks are {sectorWarn.sector} — crowded.</div>}
          {diff && (diff.entered.length || diff.dropped.length) ? (
            <div className="glass-panel" style={{ padding: '0.6rem 1rem', marginBottom: '0.75rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              vs recorded {diff.date}: {diff.entered.length ? <span style={{ color: '#34d399' }}>+ {diff.entered.join(', ')}</span> : null} {diff.dropped.length ? <span style={{ color: '#fca5a5' }}>− {diff.dropped.join(', ')}</span> : null}
            </div>
          ) : null}
          {history && history.available === false && <div className="glass-panel" style={{ padding: '0.6rem 1rem', marginBottom: '0.75rem', fontSize: '0.78rem', color: '#fcd34d' }}>{history.hint}</div>}

          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.5rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            <span>Track record (recorded picks vs SPY):</span>
            <SignalScore signal="us_picks_top25" label="Top 25" market="US" />
            <SignalScore signal="us_picks_top10" label="Top 10" market="US" />
            <button onClick={summarize} disabled={summarizing} style={{ marginLeft: 'auto', padding: '0.35rem 0.8rem', borderRadius: 4, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.75rem' }}>{summarizing ? 'Writing…' : 'AI brief'}</button>
          </div>
          {summary && <div className="glass-panel" style={{ padding: '1.1rem 1.4rem', marginBottom: '1rem', lineHeight: 1.6, fontSize: '0.9rem' }}><ReactMarkdown>{summary}</ReactMarkdown></div>}

          <div className="glass-panel" style={{ padding: '0.4rem', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead><tr>
                <th style={th}>#</th><th style={th}>Symbol</th><th style={th}>Sector</th><th style={th}>Price</th><th style={th} title="Weighted blend of the factor percentiles">Score</th>
                {FACTORS.map(f => <th key={f.key} style={th} title={f.help}>{f.label}</th>)}
                <th style={th}>Flags</th>
              </tr></thead>
              <tbody>
                {top.map(r => (
                  <tr key={r.symbol} onClick={() => navigate(`/us/${encodeURIComponent(r.symbol)}`)} style={{ cursor: 'pointer' }}>
                    <td style={td}>{r.rank}</td>
                    <td style={td}><strong>{r.symbol}</strong><div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>{r.name}</div></td>
                    <td style={{ ...td, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{r.sector || '—'}</td>
                    <td style={td}>{fmtUsd(r.lastClose)}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{r.composite.toFixed(0)}</td>
                    {FACTORS.map(f => <td key={f.key} style={td}><Bar pct={r.pct[f.key]} color={f.color} /></td>)}
                    <td style={td}>
                      {r.factors.trapRisk && <Chip color="#fbbf24" title={r.factors.trapReason}>trap</Chip>}
                      {r.factors.newHigh5 && <Chip color="#34d399" title="Fresh 252-session high in the last 5 sessions">52w high</Chip>}
                      {r.flags.map(f => <Chip key={f.id} color="#fbbf24" title={f.title}>{f.id}</Chip>)}
                      {r.earningsDate && <Chip color="#c084fc" title="Next earnings date">📅 {r.earningsDate.slice(5)}</Chip>}
                      {r.factors.revisionsRaw == null && <Chip title="No EPS revisions data — ranked neutral on that factor">no rev.</Chip>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: '0.5rem 0 0' }}>
            Factors percentile-ranked across {ranked.length} stocks as of {data.period.snapshotDate}. Momentum {fmtPct(top[0]?.factors.momentumRaw == null ? null : top[0].factors.momentumRaw * 100)} means the #1 name's 20/5 return. Not investment advice.
          </p>
        </>
      )}

      {/* Backtest */}
      <div className="glass-panel" style={{ marginTop: '1.5rem', padding: '1rem 1.25rem' }}>
        <button onClick={loadBacktest} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.85rem', padding: 0 }}>{backtestOpen ? '▾' : '▸'} Backtest — four price factors, 2015 → today</button>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Where the backtest and the track record above disagree, the track record is the honest number.</div>
        {backtestOpen && (backtestLoading ? <div className="loader" /> : backtest?.error ? <div style={{ color: '#ef4444', marginTop: '0.5rem' }}>{backtest.error}</div> : backtest ? (
          <div style={{ marginTop: '0.75rem', fontSize: '0.8rem' }}>
            <div style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>{backtest.period.evalDates} evaluation dates, {backtest.period.firstEval} → {backtest.period.lastEval}, {backtest.period.universe} names. Revisions weight 0 here; the live model uses 15.</div>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr><th style={th}>Horizon</th><th style={th}>Top-25 vs median</th><th style={th}>Top-25 vs SPY</th><th style={th}>Top-10 vs SPY</th><th style={th}>Hit rate</th><th style={th}>Q1…Q5</th></tr></thead>
              <tbody>{backtest.summary.map(s => (
                <tr key={s.horizon}><td style={td}>{s.horizon}d</td><td style={td}>{fmtPct(s.meanExcessVsMedianPct, 2)} <span style={{ color: 'var(--text-secondary)' }}>t={s.tVsMedian}</span></td><td style={td}>{fmtPct(s.meanExcessVsSpyPct, 2)} <span style={{ color: 'var(--text-secondary)' }}>t={s.tVsSpy}</span></td><td style={td}>{fmtPct(s.top10ExcessVsSpyPct, 2)}</td><td style={td}>{s.hitRatePct}%</td><td style={{ ...td, fontSize: '0.72rem' }}>{s.quintileMeansPct.map(q => q == null ? '—' : q.toFixed(2)).join(' / ')}</td></tr>
              ))}</tbody>
            </table>
            <div style={{ marginTop: '0.6rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
              <div><strong>IC (10d)</strong>{backtest.ics.map(i => <div key={i.factor} style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{i.factor}: {i.meanIC} (t={i.tStat})</div>)}</div>
              <div><strong>Momentum window sweep (10d vs SPY)</strong>{backtest.sweep.map(s => <div key={`${s.momentum.window}/${s.momentum.skip}`} style={{ fontSize: '0.75rem', color: s.shipped ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{s.momentum.window}/{s.momentum.skip}{s.shipped ? ' (shipped)' : ''}: {fmtPct(s.meanExcessVsSpyPct, 2)} t={s.tStat} IC {s.icComposite}</div>)}</div>
            </div>
            <ul style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.6rem', paddingLeft: '1.1rem' }}>{backtest.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </div>
        ) : null)}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Route** — in `frontend/src/App.jsx` add `import UsStockPicks from './pages/us/UsStockPicks'` beside the other US imports, and the route **before** `/us/:symbol`:

```jsx
          <Route path="/us/stock-picks" element={<UsStockPicks />} />
```

- [ ] **Step 3: Nav** — in `frontend/src/components/Navbar.jsx`, add to `US_LINKS` after Screener:

```js
  { to: '/us/stock-picks', label: 'Quant Picks', hint: 'Five-factor ranking of S&P 500 + Nasdaq 100 with a recorded track record vs SPY.' },
```

and add `'/us/stock-picks'` to the exclusion array in the `active` computation (`['/us/macro', '/us/screener', '/us/stock-picks', '/us/basket', '/us/virtual']`).

- [ ] **Step 4: Build and verify in the browser**

Run: `cd frontend && npx vite build 2>&1 | grep -E "built in|error"`
Expected: `✓ built`

Then, with the backend running and the app logged in, open `/us/stock-picks`: regime line present, table renders `topN` rows, sliders re-rank, the two badges read either "No snapshots recorded yet"/"too few to judge" or a number, and the backtest panel expands. Use the Browser pane tools; take a screenshot.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/us/UsStockPicks.jsx frontend/src/App.jsx frontend/src/components/Navbar.jsx
git commit -m "US Quant Picks page under the US menu

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: First snapshot and hand-off

**Files:** none new.

- [ ] **Step 1: Create the table** — run `cd backend && node migrate_us_pick_snapshots.js`, paste the SQL into the Supabase SQL editor, re-run the script until it prints `us_pick_snapshots is reachable.`

- [ ] **Step 2: Confirm the momentum default** — re-read `docs/superpowers/specs/2026-09-03-us-quant-picks-backtest.txt` from Task 8. If 20/5 is not the strongest window by a clear margin, do not take the first snapshot; report the sweep to the user and ask which default to record.

- [ ] **Step 3: First snapshot** — with the backend running and after the US close (≥ 21:00 UTC): `curl -s -X POST http://localhost:3001/api/us/stock-picks/snapshot`. Expected `{ snapDate, saved: 25 }`. Then `GET /api/us/stock-picks/history` shows one date and the page's diff panel goes quiet.

- [ ] **Step 4: Run every test**

Run: `cd backend && npm test 2>&1 | tail -6 && cd ../frontend && npm test 2>&1 | tail -6`
Expected: all PASS.

- [ ] **Step 5: Commit anything left, then report** — what the backtest said, what the first snapshot recorded, and that the badges will read "too few to judge" until ~20 sessions have resolved.

---

## Self-review

**Spec coverage:** universe (T5 `loadMembers`), five factors (T3, T4), trap risk (T3), exclusions (T5), regime (T3 `breadth`, T5 macro label), ranking client+server with null→50 (T5, T10), snapshot table + per-factor percentiles (T6, T5 `saveDailySnapshot`), daily job keyed to the SPY bar (T9), scorecard vs SPY with factor IC (T7), registry entries + Indian scorer skip + benchmark label (T6), `SignalScore market="US"` (T11), backtest with both benchmarks, quintiles, IC, sweep, caveats (T8), page/route/nav/AI brief/history diff (T9, T12), tests per spec (T1–T10), migration pattern (T6), Alpaca-not-configured 503 shape (T9 routes via `err.notConfigured`).

**Placeholder scan:** Task 2 Step 5 references "the existing try-block body" — that is a deliberate move of unchanged code, with its start and end lines named. No TBDs.

**Type consistency:** `percentileRanks` null→50 in both T5 and T10; `rankUniverse` returns `pct`/`composite`/`rank` consumed by T5 `saveDailySnapshot`, T8, T7 badge; `buildUniverseFrom(inputs, { asOf, momentum })` used identically in T8; scorecard row keys `momentum_pct` … `revisions_pct` match the DDL in T6 and the writes in T5; `usSnapshotDue(spyLast, snapLast, now)` matches its tests; `getEarningsCalendar` exported in T2 and required lazily in T5; `headline(..., { benchmarkLabel })` added in T6 and used in T7.
