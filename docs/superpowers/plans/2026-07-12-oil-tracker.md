# Crude Oil Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dedicated `/market-data/oil` page tracking WTI + Brent crude spot prices (day change, day range, 52-week range), fed by a new cached `GET /api/oil` endpoint.

**Architecture:** One thin backend endpoint proxies `yahooFinance.quote(['CL=F','BZ=F'])` with a 2-minute cache and stale-serve fallback. One new React page renders two stat cards with range bars, 60s auto-refresh. Navbar sublink + route wire it in.

**Tech Stack:** Node/Express (`backend/server.js`), `yahoo-finance2` (already instantiated as `yahooFinance` at server.js:8), React (Vite).

## Global Constraints

- Data is **10-minute delayed** (NYMEX free feed) — the page must show "10-min delayed" and an as-of time from `quoteTime`.
- Endpoint response shape (both grades identical):
  `{ wti: { symbol, name, price, change, changePct, prevClose, dayLow, dayHigh, week52Low, week52High, currency, quoteTime, delayMin, marketState }, brent: {...}, asOf, stale? }`
- Names hardcoded: `"WTI Crude"` / `"Brent Crude"` (Yahoo shortNames are contract-month noise).
- All numeric fields `?? null`; frontend renders `—` for nulls.
- Cache TTL 2 minutes; on Yahoo failure serve expired cache with `stale: true`, else 502 `{ error }`.
- Match existing idioms: `glass-panel` cards, `positive`/`negative` classes, `.loader`, `dashboard-layout`, `var(--accent)`/`var(--text-secondary)`.
- No new dependencies. No backend unit test (thin cached proxy, same class as `/api/analysts`) — verification is live curl + preview.

---

## File Structure

- **Modify** `backend/server.js` — `/api/oil` endpoint + module cache (place near the `/api/analysts/:symbol` route, ~line 2233).
- **Create** `frontend/src/pages/marketData/OilTracker.jsx` — the page.
- **Modify** `frontend/src/components/Navbar.jsx` — one sublink in the Market Data array (~line 16, after the events entry).
- **Modify** `frontend/src/App.jsx` — import + one route (next to the other `/market-data/*` routes, ~line 173).

---

## Task 1: Backend `GET /api/oil`

**Files:**
- Modify: `backend/server.js` (add above the `/api/analysts/:symbol` block, ~line 2233)

**Interfaces:**
- Consumes: `yahooFinance` (instance at server.js:8).
- Produces: `GET /api/oil` → `{ wti, brent, asOf, stale? }` per Global Constraints. Task 2 consumes this exact shape.

- [ ] **Step 1: Add the endpoint + cache**

Insert into `backend/server.js` (above the `/api/analysts` section around line 2233):

```js
// ─── GET /api/oil — WTI + Brent crude spot (Yahoo, 10-min delayed) ──────────
// Thin cached proxy over one Yahoo quote call. Names are hardcoded because
// Yahoo shortNames carry contract-month noise ("Crude Oil Aug 26").
let oilCache = null; // { data, ts }
const OIL_TTL = 2 * 60 * 1000;
const mapOilQuote = (r, name) => ({
  symbol: r?.symbol ?? null,
  name,
  price: r?.regularMarketPrice ?? null,
  change: r?.regularMarketChange ?? null,
  changePct: r?.regularMarketChangePercent ?? null,
  prevClose: r?.regularMarketPreviousClose ?? null,
  dayLow: r?.regularMarketDayLow ?? null,
  dayHigh: r?.regularMarketDayHigh ?? null,
  week52Low: r?.fiftyTwoWeekLow ?? null,
  week52High: r?.fiftyTwoWeekHigh ?? null,
  currency: r?.currency ?? 'USD',
  quoteTime: r?.regularMarketTime ?? null,
  delayMin: r?.exchangeDataDelayedBy ?? 10,
  marketState: r?.marketState ?? null,
});
app.get('/api/oil', async (req, res) => {
  if (oilCache && Date.now() - oilCache.ts < OIL_TTL) return res.json(oilCache.data);
  try {
    const q = await yahooFinance.quote(['CL=F', 'BZ=F'], {}, { validateResult: false });
    const bySym = Object.fromEntries((Array.isArray(q) ? q : [q]).map(r => [r.symbol, r]));
    const data = {
      wti: mapOilQuote(bySym['CL=F'], 'WTI Crude'),
      brent: mapOilQuote(bySym['BZ=F'], 'Brent Crude'),
      asOf: new Date().toISOString(),
    };
    oilCache = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    if (oilCache) return res.json({ ...oilCache.data, stale: true });
    res.status(502).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Restart backend and verify live**

Backend runs as plain `node server.js` (port 3001, loads `../.env`). Restart: find PID (`ps aux | grep "node server.js" | grep -v grep`), kill it, then from `backend/`: `nohup node server.js > /tmp/kite-backend.log 2>&1 &`, ONE `sleep 3` (no polling loops). Then:

```bash
curl -s http://localhost:3001/api/oil | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('WTI',j.wti.price,j.wti.changePct,'| Brent',j.brent.price,j.brent.changePct,'| quoteTime',j.wti.quoteTime,'| delay',j.wti.delayMin)})"
```

Expected: real prices (WTI ~70s, Brent a few $ higher), non-null quoteTime, delay 10. Second curl within 2 min returns instantly (cache). Report actual values.

- [ ] **Step 3: Confirm tests untouched**

Run: `cd backend && npm test`
Expected: 8 pass, 0 fail (no test changes in this task).

- [ ] **Step 4: Commit**

```bash
git add backend/server.js
git commit -m "feat(oil): cached WTI + Brent spot endpoint (Yahoo)"
```

---

## Task 2: Oil page + navbar/route wiring

**Files:**
- Create: `frontend/src/pages/marketData/OilTracker.jsx`
- Modify: `frontend/src/components/Navbar.jsx` (Market Data sublinks array, ~lines 8–16)
- Modify: `frontend/src/App.jsx` (import + route beside the other `/market-data/*` routes, ~line 173)

**Interfaces:**
- Consumes: `GET /api/oil` → `{ wti, brent, asOf, stale? }`; each grade `{ symbol, name, price, change, changePct, prevClose, dayLow, dayHigh, week52Low, week52High, currency, quoteTime, delayMin, marketState }`, all numerics possibly null.
- Produces: route `/market-data/oil`.

- [ ] **Step 1: Create the page**

Create `frontend/src/pages/marketData/OilTracker.jsx`:

```jsx
import { useState, useEffect, useCallback } from 'react'

// Crude oil spot tracker: WTI (CL=F) + Brent (BZ=F) from /api/oil (Yahoo,
// 10-min delayed NYMEX). Spot cards only — chart/spread are deliberate
// non-goals (see docs/superpowers/specs/2026-07-12-oil-tracker-design.md).
const GREY = 'var(--text-secondary)'
const REFRESH_MS = 60000

const fmt = (v, digits = 2) => (v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }))

// Horizontal range bar: low ── ● ── high, marker at `value`.
function RangeBar({ low, high, value, lowLabel, highLabel }) {
  if (low == null || high == null || value == null || high <= low) return null
  const pct = Math.max(0, Math.min(100, ((value - low) / (high - low)) * 100))
  return (
    <div style={{ marginTop: '0.35rem' }}>
      <div style={{ position: 'relative', height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.08)' }}>
        <div style={{ position: 'absolute', left: `calc(${pct}% - 4px)`, top: '-2px', width: '10px', height: '10px', borderRadius: '50%', background: 'var(--accent)' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem', color: GREY, marginTop: '0.2rem' }}>
        <span>{lowLabel}</span><span>{highLabel}</span>
      </div>
    </div>
  )
}

function GradeCard({ g }) {
  if (!g) return null
  const up = (g.change ?? 0) >= 0
  return (
    <div className="glass-panel" style={{ padding: '1.25rem 1.5rem', flex: '1 1 320px', minWidth: '300px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '1.05rem' }}>{g.name}</h3>
        <span style={{ fontSize: '0.68rem', fontWeight: 700, color: GREY, border: '1px solid var(--border)', borderRadius: '4px', padding: '0.08rem 0.35rem' }}>{g.symbol ?? '—'}</span>
        {g.marketState && <span style={{ fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: g.marketState === 'REGULAR' ? '#34d399' : GREY }}>{g.marketState}</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.7rem', margin: '0.6rem 0 0.2rem' }}>
        <span style={{ fontSize: '2rem', fontWeight: 800 }}>${fmt(g.price)}</span>
        {g.change != null && (
          <span className={up ? 'positive' : 'negative'} style={{ fontWeight: 700 }}>
            {up ? '+' : ''}{fmt(g.change)} ({up ? '+' : ''}{fmt(g.changePct)}%)
          </span>
        )}
      </div>
      <div style={{ fontSize: '0.78rem', color: GREY }}>Prev close ${fmt(g.prevClose)}</div>
      <div style={{ marginTop: '0.9rem' }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: GREY }}>Day range</div>
        <RangeBar low={g.dayLow} high={g.dayHigh} value={g.price} lowLabel={`$${fmt(g.dayLow)}`} highLabel={`$${fmt(g.dayHigh)}`} />
      </div>
      <div style={{ marginTop: '0.8rem' }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: GREY }}>52-week range</div>
        <RangeBar low={g.week52Low} high={g.week52High} value={g.price} lowLabel={`$${fmt(g.week52Low)}`} highLabel={`$${fmt(g.week52High)}`} />
      </div>
    </div>
  )
}

export default function OilTracker() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/oil')
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setData(j); setError(null)
    } catch (e) { setError(e.message) }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  if (error && !data) return (
    <div className="dashboard-layout">
      <div className="glass-panel" style={{ padding: '1.5rem' }}>
        <p className="negative" style={{ margin: 0 }}>Oil prices unavailable: {error}</p>
        <button onClick={load} style={{ marginTop: '1rem', padding: '0.5rem 1rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Retry</button>
      </div>
    </div>
  )
  if (!data) return <div className="loader" />

  const asOf = data.wti?.quoteTime ? new Date(data.wti.quoteTime).toLocaleTimeString() : null
  return (
    <div className="dashboard-layout">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.25rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>Crude Oil</h1>
          <p style={{ margin: '0.3rem 0 0', color: GREY, fontSize: '0.85rem' }}>
            WTI &amp; Brent spot · Yahoo Finance · {data.wti?.delayMin ?? 10}-min delayed
            {asOf && <> · as of {asOf}</>}
            {data.stale && <span style={{ color: '#fbbf24' }}> · stale data</span>}
          </p>
        </div>
        <button onClick={load} title="Refresh prices"
          style={{ padding: '0.4rem 0.9rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 700, border: '1px solid rgba(56,189,248,0.25)', background: 'rgba(56,189,248,0.08)', color: 'var(--accent)' }}>
          ↻ Refresh
        </button>
      </div>
      <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap' }}>
        <GradeCard g={data.wti} />
        <GradeCard g={data.brent} />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Navbar sublink**

In `frontend/src/components/Navbar.jsx`, append to the Market Data sublinks array (after the `/market-data/events` entry, ~line 16):

```js
  { to: '/market-data/oil',                 label: 'Crude Oil (WTI / Brent)',   hint: 'WTI & Brent spot, day change and ranges (10-min delayed).' },
```

- [ ] **Step 3: Route**

In `frontend/src/App.jsx`: add the import next to the other marketData imports:

```js
import OilTracker from './pages/marketData/OilTracker'
```

and the route beside the other `/market-data/*` routes (~line 173):

```jsx
          <Route path="/market-data/oil" element={<OilTracker />} />
```

- [ ] **Step 4: Verify in preview (reuse running `frontend-preview` port 5180; NO new server, NO sleep loops; MAX 4 preview calls)**

Navigate via preview_eval: `history.pushState({},'','/market-data/oil'); window.dispatchEvent(new PopStateEvent('popstate'))`, one short wait. Then:
- `preview_console_logs` level error → must be clean.
- `preview_snapshot` → confirm "Crude Oil" heading, both grade cards with real prices (backend live), day/52-week range labels, delayed disclosure.
Report the real prices seen.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/marketData/OilTracker.jsx frontend/src/components/Navbar.jsx frontend/src/App.jsx
git commit -m "feat(oil): crude oil tracker page + nav wiring"
```

---

## Self-Review

- **Spec coverage:** endpoint + cache + stale-serve (Task 1) ✔; page with cards, range bars, prev close, delayed disclosure, 60s refresh, manual refresh, error/retry, stale note (Task 2) ✔; navbar + route (Task 2) ✔; nullable-safe rendering ✔; no chart/spread/INR ✔.
- **Type consistency:** Task 2 consumes exactly Task 1's shape (`wti`/`brent`/`asOf`/`stale`, grade fields match `mapOilQuote`).
- **Placeholder scan:** complete code in every step; exact paths/lines; exact commands with expected output.
- **Note:** partial-result case (one symbol missing) — `mapOilQuote(undefined, name)` yields all-null grade; `GradeCard` renders `—`s (price null → `$—`), acceptable per spec ("render the available card, `—` card for the other").
