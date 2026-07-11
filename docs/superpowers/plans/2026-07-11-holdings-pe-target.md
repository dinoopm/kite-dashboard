# Holdings P/E + Analyst Target Columns — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add two columns — **P/E** and **Analyst Target** (mean target price + upside % vs current) — to the India Equity Holdings table and the US holdings (virtual-portfolio) table, each fed by a new bulk fundamentals endpoint.

**Architecture:** Two new bulk POST endpoints mirror the existing `/api/instrument-names` pattern: given `{ symbols }`, return `{ SYM: { pe, targetMean, currentPrice } }` from one cached Yahoo `quoteSummary` per symbol, bounded concurrency. Each frontend table fetches once after holdings load (like the existing `companyNames` fetch) and renders two sortable columns.

**Tech Stack:** Node/Express, `yahooFinance.quoteSummary` (already used in both `server.js` and `alpaca.js`), React (Vite).

## Global Constraints

- Bulk endpoint response shape (both platforms): `{ [SYMBOL]: { pe: number|null, targetMean: number|null, currentPrice: number|null } }`.
- Data from ONE `yahooFinance.quoteSummary(sym, { modules: ['summaryDetail','financialData','price'] }, { validateResult: false })` per symbol: `pe = summaryDetail.trailingPE ?? null`, `targetMean = financialData.targetMeanPrice ?? null`, `currentPrice = financialData.currentPrice ?? price.regularMarketPrice ?? null`.
- India resolves the Yahoo symbol via the existing `toYahooSymbol(sym)` helper; US uses the raw symbol.
- Bounded concurrency (max 6 in flight) + per-symbol cache (1h TTL). Never let one symbol's failure reject the whole batch — catch per symbol, return nulls.
- Target column renders: `₹<targetMean>` (India) / `$<targetMean>` (US) plus upside `((targetMean - current)/current)*100` as a signed, colored `%` (green ≥ 0, red < 0). Show `—` when `targetMean` null. P/E shows `—` when null.
- Match each table's existing sortable-column conventions (`handleSort`/`SortIcon` on India; the US table's own sort). Fix any total/summary-row `colSpan` so alignment stays correct.
- India table: `frontend/src/pages/Portfolio.jsx`. US table: `frontend/src/pages/us/UsVirtualPortfolioDetail.jsx`. No other pages.

---

## Task 1: India bulk fundamentals endpoint

**Files:**
- Modify: `backend/server.js` (add endpoint near `/api/instrument-names`, ~line 1055; `toYahooSymbol` + `yahooFinance` already in scope)

**Interfaces:**
- Produces: `POST /api/holdings-fundamentals` body `{ symbols: string[] }` → `{ [SYM]: { pe, targetMean, currentPrice } }`.

- [ ] **Step 1: Add a module-level cache above the endpoint**

```js
// Bulk P/E + analyst target for holdings tables (Yahoo, ₹). Cached per symbol.
const holdingsFundCacheIN = {}; // sym -> { data, ts }
const HOLDINGS_FUND_TTL = 60 * 60 * 1000; // 1h
```

- [ ] **Step 2: Add the endpoint**

```js
// POST /api/holdings-fundamentals  body: { symbols: ['RELIANCE','TCS',...] }
// → { RELIANCE: { pe, targetMean, currentPrice }, ... }
app.post('/api/holdings-fundamentals', async (req, res) => {
  const { symbols = [] } = req.body || {};
  if (!Array.isArray(symbols) || !symbols.length) return res.json({});
  const uniq = [...new Set(symbols)];
  const out = {};
  const CONCURRENCY = 6;
  let i = 0;
  const worker = async () => {
    while (i < uniq.length) {
      const sym = uniq[i++];
      const hit = holdingsFundCacheIN[sym];
      if (hit && Date.now() - hit.ts < HOLDINGS_FUND_TTL) { out[sym] = hit.data; continue; }
      try {
        const q = await yahooFinance.quoteSummary(toYahooSymbol(sym),
          { modules: ['summaryDetail', 'financialData', 'price'] }, { validateResult: false });
        const sd = q.summaryDetail || {}, fd = q.financialData || {}, price = q.price || {};
        const data = {
          pe: sd.trailingPE ?? null,
          targetMean: fd.targetMeanPrice ?? null,
          currentPrice: fd.currentPrice ?? price.regularMarketPrice ?? null,
        };
        holdingsFundCacheIN[sym] = { data, ts: Date.now() };
        out[sym] = data;
      } catch { out[sym] = { pe: null, targetMean: null, currentPrice: null }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, uniq.length) }, worker));
  res.json(out);
});
```

- [ ] **Step 3: Verify (backend restart + curl)**

Restart backend: find `node server.js` PID (`ps aux | grep "node server.js" | grep -v grep`), kill it, then from `backend/`: `nohup node server.js > /tmp/kite-backend.log 2>&1 &`, wait ~3s. Then:
```bash
curl -s -X POST http://localhost:3001/api/holdings-fundamentals -H 'Content-Type: application/json' -d '{"symbols":["RELIANCE","TCS"]}'
```
Expected: `{"RELIANCE":{"pe":<num>,"targetMean":<num>,"currentPrice":<num>},"TCS":{...}}`. Report the actual values seen. Run `cd backend && npm test` (must stay 8 pass).

- [ ] **Step 4: Commit**

```bash
git add backend/server.js
git commit -m "feat(holdings): bulk P/E + analyst-target endpoint (India, Yahoo)"
```

---

## Task 2: India Equity Holdings — P/E + Target columns

**Files:**
- Modify: `frontend/src/pages/Portfolio.jsx` (state ~line 36; bulk fetch effect ~line 111; `<th>` header row ~lines 485–495; row `<td>` cells in the equity holdings `.map`; any total/summary row `colSpan`)

**Interfaces:**
- Consumes: `POST /api/holdings-fundamentals` (Task 1) → `{ SYM: { pe, targetMean, currentPrice } }`.

- [ ] **Step 1: Add state**

Next to `const [companyNames, setCompanyNames] = useState({})` (~line 36):
```js
  const [fundamentals, setFundamentals] = useState({}) // symbol -> { pe, targetMean, currentPrice }
```

- [ ] **Step 2: Fetch in bulk after holdings load**

Add an effect mirroring the existing `companyNames` fetch (the one POSTing to `/api/instrument-names`, ~line 111). Duplicate its structure but hit the new endpoint:
```js
  useEffect(() => {
    if (!holdings || !holdings.length) return;
    let on = true;
    const symbols = [...new Set(holdings.map(h => h.tradingsymbol))];
    fetch('/api/holdings-fundamentals', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbols }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (on && j && !j.error) setFundamentals(j) })
      .catch(() => {})
    return () => { on = false };
  }, [holdings])
```

- [ ] **Step 3: Add two header cells**

In the equity holdings `<thead>` row (~485–495), add after the `LTP` header (`last_price`):
```jsx
                    <th onClick={() => handleSort('pe')} style={{cursor: 'pointer'}}>P/E <SortIcon field="pe"/></th>
                    <th onClick={() => handleSort('targetMean')} style={{cursor: 'pointer'}}>Target <SortIcon field="targetMean"/></th>
```

- [ ] **Step 4: Add two body cells per row**

In the equity holdings row `.map`, add the two cells at the SAME position (right after the LTP cell). Read the row-map to match its exact markup/number formatting, then insert:
```jsx
                    <td>{fundamentals[h.tradingsymbol]?.pe != null ? fundamentals[h.tradingsymbol].pe.toFixed(1) : '—'}</td>
                    <td>
                      {(() => {
                        const f = fundamentals[h.tradingsymbol];
                        if (!f || f.targetMean == null) return '—';
                        const cur = f.currentPrice ?? h.last_price;
                        const up = cur ? ((f.targetMean - cur) / cur) * 100 : null;
                        return <>
                          ₹{f.targetMean.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                          {up != null && <span className={up >= 0 ? 'positive' : 'negative'} style={{ fontSize: '0.72rem', marginLeft: '0.3rem' }}>{up >= 0 ? '+' : ''}{up.toFixed(0)}%</span>}
                        </>;
                      })()}
                    </td>
```

- [ ] **Step 5: Sorting support**

The table uses `handleSort(field)` + a sorted list. Find where rows are sorted (the comparator that reads `average_price`/`last_price`/etc.). Ensure `pe` and `targetMean` sort correctly: they live in `fundamentals[symbol]`, not on the holding row. In the sort comparator, add handling so that when `sortField === 'pe'` or `'targetMean'`, it reads `fundamentals[h.tradingsymbol]?.[sortField]` (nulls sort last). If the comparator is generic on `h[field]`, add a small getter: `const sortVal = (h, field) => (field === 'pe' || field === 'targetMean') ? (fundamentals[h.tradingsymbol]?.[field] ?? null) : h[field];` and use it. Keep null-last ordering consistent with existing behavior.

- [ ] **Step 6: Fix total/summary row colSpan**

If there is a totals/summary `<tr>` under the equity table with a `colSpan` spanning the columns, increase it by 2 (two new columns) OR add two empty `<td>`s at the matching position so columns stay aligned. Read the table footer to apply correctly.

- [ ] **Step 7: Verify (preview — reuse running `frontend-preview` 5180; MAX ~4 calls; NO scans, NO sleep loops)**

Navigate to the portfolio route (find it in the app router, e.g. `/portfolio`). Then: `preview_console_logs` level error (clean), `preview_snapshot` to confirm `P/E` + `Target` headers appear in the Equity Holdings table. Live Kite data may be absent (no login) → cells show `—`, which is correct; confirm no console errors and the headers render. Report what you saw.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/Portfolio.jsx
git commit -m "feat(holdings): P/E + analyst target columns on India Equity Holdings"
```

---

## Task 3: US bulk fundamentals endpoint

**Files:**
- Modify: `backend/alpaca.js` (add a router endpoint; `yahooFinance` is already required/used in this file — confirm by the existing `quoteSummary` usage around line 1284)

**Interfaces:**
- Produces: `POST /api/us/holdings-fundamentals` body `{ symbols }` → `{ [SYM]: { pe, targetMean, currentPrice } }`.

- [ ] **Step 1: Add cache + endpoint**

Confirm how `yahooFinance` is referenced in `alpaca.js` (match the existing import/usage near line 1284). Then add:
```js
// Bulk P/E + analyst target for the US holdings table (Yahoo, $). Cached per symbol.
const usHoldingsFundCache = {}; // sym -> { data, ts }
const US_HOLDINGS_FUND_TTL = 60 * 60 * 1000; // 1h

router.post('/holdings-fundamentals', async (req, res) => {
  const { symbols = [] } = req.body || {};
  if (!Array.isArray(symbols) || !symbols.length) return res.json({});
  const uniq = [...new Set(symbols.map(s => String(s).toUpperCase()))];
  const out = {};
  const CONCURRENCY = 6;
  let i = 0;
  const worker = async () => {
    while (i < uniq.length) {
      const sym = uniq[i++];
      const hit = usHoldingsFundCache[sym];
      if (hit && Date.now() - hit.ts < US_HOLDINGS_FUND_TTL) { out[sym] = hit.data; continue; }
      try {
        const q = await yahooFinance.quoteSummary(sym,
          { modules: ['summaryDetail', 'financialData', 'price'] }, { validateResult: false });
        const sd = q.summaryDetail || {}, fd = q.financialData || {}, price = q.price || {};
        const data = {
          pe: sd.trailingPE ?? null,
          targetMean: fd.targetMeanPrice ?? null,
          currentPrice: fd.currentPrice ?? price.regularMarketPrice ?? null,
        };
        usHoldingsFundCache[sym] = { data, ts: Date.now() };
        out[sym] = data;
      } catch { out[sym] = { pe: null, targetMean: null, currentPrice: null }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, uniq.length) }, worker));
  res.json(out);
});
```
If `yahooFinance` is NOT already imported in `alpaca.js`, add the same require the file's fundamentals route uses (check line ~1284's surrounding code for the exact reference) — do not introduce a different import style.

- [ ] **Step 2: Verify (restart + curl)**

Restart backend (same steps as Task 1 Step 3). Then:
```bash
curl -s -X POST http://localhost:3001/api/us/holdings-fundamentals -H 'Content-Type: application/json' -d '{"symbols":["AAPL","MSFT"]}'
```
Expected: `{"AAPL":{"pe":<num>,"targetMean":<num>,"currentPrice":<num>},"MSFT":{...}}` — Alpaca/Yahoo are configured, so expect real numbers. Report values. `cd backend && npm test` stays green.

- [ ] **Step 3: Commit**

```bash
git add backend/alpaca.js
git commit -m "feat(holdings): bulk P/E + analyst-target endpoint (US, Yahoo)"
```

---

## Task 4: US holdings table — P/E + Target columns

**Files:**
- Modify: `frontend/src/pages/us/UsVirtualPortfolioDetail.jsx` (holdings state/load ~lines 36–115; the holdings table header + row `.map`; totals row)

**Interfaces:**
- Consumes: `POST /api/us/holdings-fundamentals` (Task 3) → `{ SYM: { pe, targetMean, currentPrice } }`. Note this file uses an `API` base prefix for fetches (e.g. `` `${API}/api/us/...` ``) — match it.

- [ ] **Step 1: Add state + bulk fetch**

Add `const [fundamentals, setFundamentals] = useState({});` near the holdings state (~line 36). After holdings load, fetch in bulk (mirror the file's existing fetch style, using its `API` prefix and, if present, `fetchWithAbort`):
```js
  useEffect(() => {
    if (!holdings || !holdings.length) return;
    let on = true;
    const symbols = [...new Set(holdings.map(h => h.symbol).filter(Boolean))];
    fetch(`${API}/api/us/holdings-fundamentals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbols }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (on && j && !j.error) setFundamentals(j) })
      .catch(() => {})
    return () => { on = false };
  }, [holdings])
```
Confirm the holdings row's symbol field name (it may be `h.symbol` or `h.ticker` — read the row `.map`/`loadHoldings` mapper ~line 87 and use the real field).

- [ ] **Step 2: Add header + body cells**

In the holdings table header, add `P/E` and `Target` cells (match the file's `<th>` sort convention if it has one; otherwise plain `<th>`), positioned after the price/LTP column. In the row `.map`, add the matching two `<td>`s:
```jsx
                    <td>{fundamentals[h.symbol]?.pe != null ? fundamentals[h.symbol].pe.toFixed(1) : '—'}</td>
                    <td>
                      {(() => {
                        const f = fundamentals[h.symbol];
                        if (!f || f.targetMean == null) return '—';
                        const cur = f.currentPrice ?? h.ltp ?? h.last;
                        const up = cur ? ((f.targetMean - cur) / cur) * 100 : null;
                        return <>
                          ${f.targetMean.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                          {up != null && <span className={up >= 0 ? 'positive' : 'negative'} style={{ fontSize: '0.72rem', marginLeft: '0.3rem' }}>{up >= 0 ? '+' : ''}{up.toFixed(0)}%</span>}
                        </>;
                      })()}
                    </td>
```
Use the real symbol field and the real current-price field from this file's holding shape (read the row map first). Fix the totals row `colSpan`/empty cells for +2 columns.

- [ ] **Step 3: Verify (preview — reuse running `frontend-preview` 5180; MAX ~4 calls; NO scans/sleep loops)**

Navigate to a US virtual portfolio detail route (find the path + a valid portfolio id via the app router / US virtual portfolio list; if no portfolio exists, at least load the US virtual portfolio list route and confirm no console errors, then report). Confirm `P/E` + `Target` headers render and, if a portfolio with holdings exists, real values appear (Yahoo configured). `preview_console_logs` level error must be clean. Report what you saw.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/us/UsVirtualPortfolioDetail.jsx
git commit -m "feat(holdings): P/E + analyst target columns on US holdings"
```

---

## Self-Review

- **Spec coverage:** India endpoint (T1) + India columns (T2); US endpoint (T3) + US columns (T4). Both platforms ✔. Target = price + upside % ✔. Bulk + cache + bounded concurrency ✔.
- **Type consistency:** both endpoints return `{ pe, targetMean, currentPrice }`; both frontends read those three keys. Symbol field differs per table (India `tradingsymbol`, US `symbol`/verify) — each task reads its own row shape.
- **Placeholder scan:** complete code in every code step; frontend cell/sort/colSpan steps instruct reading the real row markup before inserting (necessary — exact table structure varies).
- **Risk:** India live values need Kite login for holdings to exist, but the fundamentals endpoint itself is Yahoo-backed and verifiable via curl (Task 1 Step 3) independent of Kite. US is fully live-verifiable.
