# US Indices Breadth + ADX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** S&P 500 constituent breadth endpoint + breadth strip and ADX(14) column on the US indices page.

**Architecture:** New cached backend route `/api/us/breadth` computes % of S&P 500 members above their 50/200-day SMA from Alpaca multi-symbol bars. Frontend `UsIndices.jsx` renders a breadth strip (internals card from the endpoint + ETF chips from already-loaded rows) and adds a sortable ADX(14) table column computed client-side from each row's existing history. `adx14` moves to a shared lib.

**Tech Stack:** Node/Express (backend/alpaca.js), React + recharts (frontend), Alpaca market data API.

**Spec:** `docs/superpowers/specs/2026-07-14-us-breadth-adx-design.md`

## Global Constraints

- Backend port: `process.env.PORT || 3001`. The user usually runs `node server.js` themselves — for endpoint tests, run a disposable instance on port 3101 (`PORT=3101 node server.js`) and kill it after; do NOT kill the user's 3001 process.
- Breadth endpoint cache TTL: 30 minutes, in-memory, with in-flight coalescing (same pattern as `backend/usUniverses.js`).
- Bars lookback: start = now − 310 calendar days.
- A symbol needs ≥ 200 bars to count; otherwise excluded from `total`.
- Colors: green `#22c55e`, red `#ef4444`. Breadth stat thresholds: ≥ 70 green, 40–70 neutral, < 40 red.
- ADX cell rules: null → "–"; ADX ≥ 25 → green if `aboveSma50` true, red if false; 20–25 → default text; < 20 → grey "chop" styling.
- No test framework in repo — tests are one-off node scripts under the scratchpad dir, run manually. Delete nothing from the repo to add them.
- Commit messages: conventional commits, end body with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Backend `GET /api/us/breadth`

**Files:**
- Modify: `backend/alpaca.js` (add route near the other GET routes; `fetchBarsMulti` is defined around line 1590, `getSP500` is already imported at line 25)
- Test: `<scratchpad>/test-breadth.js` (one-off script)

**Interfaces:**
- Consumes: `getSP500()` → `[{ symbol, sector, ... }]`; `fetchBarsMulti(symbols, startDate)` → `{ SYM: [{ date, open, high, low, close, volume }, ...] }` (both already exist in alpaca.js).
- Produces: `GET /api/us/breadth` → `{ pctAbove50, pctAbove200, above50, above200, total, asOf, cached }` (numbers; `asOf` is `YYYY-MM-DD` string). Task 4 consumes this.

- [ ] **Step 1: Write the failing test**

Create `<scratchpad>/test-breadth.js`:

```js
// One-off test for GET /api/us/breadth. Expects a server on port 3101.
const BASE = 'http://localhost:3101';

(async () => {
  let fail = 0;
  const t0 = Date.now();
  const r1 = await fetch(`${BASE}/api/us/breadth`);
  if (r1.status !== 200) { console.log(`FAIL status ${r1.status}`); process.exit(1); }
  const j1 = await r1.json();
  const cold = Date.now() - t0;

  const check = (name, ok) => { if (!ok) { console.log(`FAIL ${name}`, JSON.stringify(j1)); fail++; } };
  check('pctAbove50 in (0,100)', j1.pctAbove50 > 0 && j1.pctAbove50 < 100);
  check('pctAbove200 in (0,100)', j1.pctAbove200 > 0 && j1.pctAbove200 < 100);
  check('total >= 450', j1.total >= 450);
  check('above50 consistent', Math.abs(j1.above50 / j1.total * 100 - j1.pctAbove50) < 0.1);
  check('asOf is date', /^\d{4}-\d{2}-\d{2}$/.test(j1.asOf));
  check('cold not cached', j1.cached === false);

  const t1 = Date.now();
  const j2 = await (await fetch(`${BASE}/api/us/breadth`)).json();
  const warm = Date.now() - t1;
  check('warm cached', j2.cached === true);
  check('warm fast', warm < 500);

  console.log(fail ? `${fail} failures` : `PASS (cold ${cold}ms, warm ${warm}ms)`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && PORT=3101 node server.js &   # wait for "Backend server running"
node <scratchpad>/test-breadth.js
```
Expected: `FAIL status 404` (route doesn't exist).

- [ ] **Step 3: Implement the route**

In `backend/alpaca.js`, add after the `/global-indices` route (~line 930) — location is flexible, keep it beside other market-wide GET routes:

```js
// ─── GET /api/us/breadth — S&P 500 % above 50/200-day SMA ───────────────────
// Heavy on cold start (~10-15 Alpaca requests for 500 symbols × ~210 bars),
// so cached for 30 min with in-flight coalescing.
const BREADTH_TTL = 30 * 60 * 1000;
let breadthCache = null; // { data, ts }
let breadthInflight = null;

async function computeBreadth() {
  const symbols = (await getSP500()).map(x => x.symbol);
  const start = new Date(Date.now() - 310 * 24 * 60 * 60 * 1000);
  const bars = await fetchBarsMulti(symbols, start);
  let above50 = 0, above200 = 0, total = 0, asOf = '';
  for (const sym of symbols) {
    const candles = bars[sym];
    if (!candles || candles.length < 200) continue;
    const closes = candles.map(c => c.close);
    const last = closes[closes.length - 1];
    const sma = (p) => closes.slice(-p).reduce((a, b) => a + b, 0) / p;
    total++;
    if (last > sma(50)) above50++;
    if (last > sma(200)) above200++;
    const d = String(candles[candles.length - 1].date).slice(0, 10);
    if (d > asOf) asOf = d;
  }
  if (!total) throw new Error('breadth: no symbols with enough history');
  return {
    pctAbove50: +(above50 / total * 100).toFixed(1),
    pctAbove200: +(above200 / total * 100).toFixed(1),
    above50, above200, total, asOf,
  };
}

router.get('/breadth', async (req, res) => {
  try {
    if (breadthCache && Date.now() - breadthCache.ts < BREADTH_TTL) {
      return res.json({ ...breadthCache.data, cached: true });
    }
    if (!breadthInflight) {
      breadthInflight = computeBreadth()
        .then(data => { breadthCache = { data, ts: Date.now() }; return data; })
        .finally(() => { breadthInflight = null; });
    }
    const data = await breadthInflight;
    res.json({ ...data, cached: false });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});
```

Note: `fetchBarsMulti` is declared with `async function` later in the file — function declarations hoist, so calling it from a route defined earlier is fine (the call happens at request time anyway).

- [ ] **Step 4: Restart test server, run test to verify it passes**

```bash
# kill the PORT=3101 instance, start it again (picks up new code), then:
node <scratchpad>/test-breadth.js
```
Expected: `PASS (cold <60000ms, warm <500ms)`. Cold run makes real Alpaca calls — allow up to a minute.

- [ ] **Step 5: Kill the 3101 server and commit**

```bash
git add backend/alpaca.js
git commit -m "feat(us): S&P 500 breadth endpoint (% above 50/200 DMA)"
```

---

### Task 2: Shared `adx14` in `frontend/src/lib/indicators.js`

**Files:**
- Create: `frontend/src/lib/indicators.js`
- Modify: `frontend/src/pages/us/UsInstrument.jsx` (delete local `adx14` at ~line 90-114; add import)

**Interfaces:**
- Produces: `adx14(bars, p = 14) => number | null` where `bars = [{ high, low, close }]`. Tasks 3 imports it.

- [ ] **Step 1: Create the lib with the exact function moved from UsInstrument.jsx:90**

`frontend/src/lib/indicators.js`:

```js
// Shared technical indicators (pure functions over daily bars).

// Wilder ADX(14). bars: [{ high, low, close }]. Returns null when the series
// is too short (< 2p+1 bars).
export const adx14 = (bars, p = 14) => {
  if (bars.length < 2 * p + 1) return null;
  const tr = [], pDM = [], mDM = [];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low - bars[i].low;
    pDM.push(up > dn && up > 0 ? up : 0);
    mDM.push(dn > up && dn > 0 ? dn : 0);
    const pc = bars[i - 1].close;
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc)));
  }
  const wilder = (arr) => { let s = arr.slice(0, p).reduce((a, b) => a + b, 0); const o = [s]; for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; o.push(s); } return o; };
  const trS = wilder(tr), pS = wilder(pDM), mS = wilder(mDM);
  const dx = [];
  for (let i = 0; i < trS.length; i++) {
    if (!trS[i]) { dx.push(0); continue; }
    const pdi = 100 * pS[i] / trS[i], mdi = 100 * mS[i] / trS[i];
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum);
  }
  if (dx.length < p) return null;
  let adx = dx.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < dx.length; i++) adx = (adx * (p - 1) + dx[i]) / p;
  return adx;
};
```

- [ ] **Step 2: Swap UsInstrument to the import**

In `frontend/src/pages/us/UsInstrument.jsx`: delete the whole `const adx14 = (bars, p = 14) => { ... };` block (~lines 90-114) and add to the imports at the top:

```js
import { adx14 } from '../../lib/indicators';
```

- [ ] **Step 3: Verify — lint + behavior unchanged**

```bash
cd frontend && npx eslint src/lib/indicators.js src/pages/us/UsInstrument.jsx
```
Expected: no errors. Then with the Vite dev server running, load `/us/SNOW` and confirm the "ADX (14)" tile in Technical Snapshot still shows a number (was 32.8 on 2026-07-14).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/indicators.js frontend/src/pages/us/UsInstrument.jsx
git commit -m "refactor(us): extract adx14 to shared lib/indicators"
```

---

### Task 3: ADX(14) column in the indices table

**Files:**
- Modify: `frontend/src/pages/us/UsIndices.jsx`
  - import block (top)
  - `enrichedData` useMemo (~line 774-934) — add `adx14` to the returned row object
  - table `<thead>` (~line 1656-1725) — new `<th>` after the RSI header (`requestSort('rsi14')`, ~line 1712)
  - table `<tbody>` — new `<td>` after the RSI cell (~line 1776-1797)
  - CSV export (~line 956-988) — header + row field
  - `emptyRowFor` (~line 84) — add `adx14: null`

**Interfaces:**
- Consumes: `adx14(bars)` from Task 2. Rows carry `history` (daily bars) and `aboveSma50` already.
- Produces: row field `adx14` (number|null), sort key `'adx14'`, CSV column `ADX14`.

Note: the row field is named `adx14` — same as the imported function. Alias the import to avoid shadowing confusion:

```js
import { adx14 as computeAdx14 } from '../../lib/indicators';
```

- [ ] **Step 1: Compute in enrichedData**

Inside the `return tabRows.map(r => { ... })` in the `enrichedData` useMemo, add to the returned object (next to `rs1M` / `rrgRatio`, ~line 921):

```js
adx14: r.history && r.history.length >= 29 ? +computeAdx14(r.history).toFixed(1) : null,
```

Also add `adx14: null` to the `emptyRowFor` placeholder object (~line 88).

- [ ] **Step 2: Header cell**

After the RSI `<th>` (~line 1712-1714), matching its style verbatim:

```jsx
<th onClick={() => requestSort('adx14')} title="ADX(14) — trend strength. ≥25 trending (green up / red down via 50DMA), <20 choppy." style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', textAlign: 'right', background: '#0f0f1e' }}>
  ADX{renderSortIndicator('adx14')}
</th>
```

- [ ] **Step 3: Body cell**

After the RSI `<td>` (~line 1797), pill styling mirroring the RSI cell:

```jsx
<td style={{ padding: '0.5rem', textAlign: 'right' }}>
  {row.adx14 === null ? (
    <span style={{ color: 'var(--text-secondary)' }}>–</span>
  ) : (
    <span style={{
      display: 'inline-block', padding: '0.2rem 0.5rem', borderRadius: '6px',
      fontSize: '0.85rem', fontWeight: '600',
      background: row.adx14 >= 25 ? (row.aboveSma50 ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)') : 'rgba(255,255,255,0.07)',
      color: row.adx14 >= 25 ? (row.aboveSma50 ? '#22c55e' : '#ef4444')
           : row.adx14 < 20 ? 'var(--text-secondary)' : 'var(--text-primary)',
      border: `1px solid ${row.adx14 >= 25 ? (row.aboveSma50 ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)') : 'rgba(255,255,255,0.1)'}`,
      opacity: row.adx14 < 20 ? 0.7 : 1,
    }}>
      {row.adx14.toFixed(1)}
    </span>
  )}
</td>
```

- [ ] **Step 4: CSV export**

In `exportCSV` (~line 959): add `'ADX14'` to `headers` after `'RSI14'`, and `r.adx14` to the row array after `r.rsi14`.

- [ ] **Step 5: Verify in browser**

Vite dev server + `/indices`? No — US page. Open the US indices page (check nav: US ▾ dropdown → Indices; route serves `UsIndices`). Confirm: ADX column renders numbers for loaded rows, click header sorts, CSV download contains ADX14 column. Then:

```bash
cd frontend && npx eslint src/pages/us/UsIndices.jsx
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/us/UsIndices.jsx
git commit -m "feat(us): ADX(14) column on indices table"
```

---

### Task 4: Breadth strip (S&P internals card + ETF chips)

**Files:**
- Modify: `frontend/src/pages/us/UsIndices.jsx`
  - new `useState`/`useEffect` for the breadth fetch (near the other fetch effects, ~line 280-440)
  - new `BreadthStrip` component defined above the main component (near `emptyRowFor`, module scope)
  - render it between the tabs block and the table area, hidden when `activeTab === 'global'`

**Interfaces:**
- Consumes: `GET /api/us/breadth` (Task 1 shape); `data` rows with `category`, `aboveSma50`, `'1D'` (already present).
- Produces: UI only.

- [ ] **Step 1: Fetch state + effect**

Inside the main component:

```js
const [breadth, setBreadth] = useState(null); // { pctAbove50, ... } | null
useEffect(() => {
  let alive = true;
  const load = async () => {
    try {
      const res = await fetchWithAbort('/api/us/breadth', { timeoutMs: 90_000 });
      const j = await res.json();
      if (alive && res.ok && j.pctAbove50 != null) setBreadth(j);
    } catch { /* card stays hidden */ }
  };
  load();
  const t = setInterval(load, 30 * 60 * 1000);
  return () => { alive = false; clearInterval(t); };
}, []);
```

(`fetchWithAbort` is already imported. If its signature rejects a missing AbortSignal, pass `{ signal: undefined, timeoutMs: 90_000 }` — check `frontend/src/hooks/useFetchWithAbort.js` first.)

- [ ] **Step 2: BreadthStrip component (module scope)**

```jsx
// Market-regime strip: S&P 500 internals (from /api/us/breadth) + sector-ETF
// breadth chips computed from rows already loaded for the table.
const breadthColor = (pct) => pct >= 70 ? '#22c55e' : pct < 40 ? '#ef4444' : '#f5c344';

function BreadthStrip({ breadth, rows }) {
  const sectorRows = rows.filter(r => r.category === 'sector' && r.aboveSma50 !== null);
  const above = sectorRows.filter(r => r.aboveSma50).length;
  const advRows = rows.filter(r => r.category === 'sector' && r['1D'] !== null);
  const adv = advRows.filter(r => r['1D'] > 0).length;
  if (!breadth && sectorRows.length === 0) return null;

  const stat = (label, pct, count, total) => (
    <div style={{ padding: '0.6rem 1rem', background: 'var(--card-bg, rgba(255,255,255,0.03))', border: '1px solid var(--border)', borderRadius: '8px', minWidth: '150px' }}>
      <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: '1.35rem', fontWeight: 700, color: breadthColor(pct) }}>{pct.toFixed(1)}%</div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{count} of {total}</div>
    </div>
  );

  const chip = (text, good) => (
    <span style={{ padding: '0.25rem 0.6rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600, border: '1px solid var(--border)', color: good ? '#22c55e' : '#ef4444', background: good ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)' }}>{text}</span>
  );

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap', margin: '0.8rem 0' }}>
      {breadth && stat('S&P 500 above 50DMA', breadth.pctAbove50, breadth.above50, breadth.total)}
      {breadth && stat('S&P 500 above 200DMA', breadth.pctAbove200, breadth.above200, breadth.total)}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        {sectorRows.length > 0 && chip(`Sectors above 50DMA: ${above}/${sectorRows.length}`, above >= sectorRows.length / 2)}
        {advRows.length > 0 && chip(`Advancing today: ${adv}/${advRows.length}`, adv >= advRows.length / 2)}
      </div>
      {breadth && <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginLeft: 'auto' }}>internals as of {breadth.asOf}</span>}
    </div>
  );
}
```

- [ ] **Step 3: Render it**

Immediately after the tabs/controls block (find `{/* Tabs and Controls */}` ~line 1115; insert after that whole block closes, before the tab-content rendering):

```jsx
{activeTab !== 'global' && <BreadthStrip breadth={breadth} rows={data} />}
```

- [ ] **Step 4: Verify in browser**

US indices page: internals card shows two percentages with sane values (cross-check against test-breadth.js output), chips show N/20 counts, `global` tab hides the strip, no console errors. Kill nothing; the user's backend on 3001 must already have Task 1 code (restart it if it predates Task 1 — coordinate with user or use the preview flow).

```bash
cd frontend && npx eslint src/pages/us/UsIndices.jsx
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/us/UsIndices.jsx
git commit -m "feat(us): market breadth strip on indices page"
```

---

### Task 5: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Backend fresh check** — `node <scratchpad>/test-breadth.js` against a restarted server carrying all changes. Expected: PASS.
- [ ] **Step 2: Browser pass** — US indices page: breadth strip + ADX column together; sort by ADX ascending and descending; switch every tab (sector/broad/commodity/global); CSV export opens with ADX14 column. `/us/SNOW` still renders Technical Snapshot ADX tile.
- [ ] **Step 3: Screenshot proof for the user.**
