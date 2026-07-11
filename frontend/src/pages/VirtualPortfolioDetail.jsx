import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { fetchWithAbort } from '../hooks/useFetchWithAbort';

const API = import.meta.env.VITE_API_URL || '';
const PRICE_REFRESH_MS = 30000; // auto-refresh LTP / day change every 30s

// ── Formatting helpers ──────────────────────────────────────────────────────
const fmtMoney = (v) => (v == null ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const fmtSignedMoney = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}₹${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const fmtQty = (v) => (v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 4 }));
const signColor = (v) => (v == null ? 'var(--text-secondary)' : v > 0 ? '#10b981' : v < 0 ? '#ef4444' : 'var(--text-secondary)');

// Derive every calculated field for one holding from its avg cost, qty and LTP.
function deriveRow(h, totalCurValue) {
  const avgCost = Number(h.avgCost) || 0;
  const qty = Number(h.quantity) || 0;
  const ltp = h.ltp != null ? Number(h.ltp) : null;
  const prevClose = h.previousClose != null ? Number(h.previousClose) : null;
  const invested = avgCost * qty;
  const curValue = ltp != null ? ltp * qty : null;
  const pnl = curValue != null ? curValue - invested : null;
  const netChgPct = avgCost > 0 && ltp != null ? ((ltp - avgCost) / avgCost) * 100 : null;
  const dayChgAbs = ltp != null && prevClose != null ? (ltp - prevClose) * qty : null;
  const dayChgPct = ltp != null && prevClose ? ((ltp - prevClose) / prevClose) * 100 : null;
  const allocation = totalCurValue > 0 && curValue != null ? (curValue / totalCurValue) * 100 : null;
  return { ...h, avgCost, qty, ltp, invested, curValue, pnl, netChgPct, dayChgAbs, dayChgPct, allocation };
}

export default function VirtualPortfolioDetail() {
  const { portfolioId } = useParams();
  const navigate = useNavigate();
  const [portfolio, setPortfolio] = useState(null);
  const [holdings, setHoldings] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null); // transient success message (e.g. merged lot)
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sortConfig, setSortConfig] = useState({ key: 'allocation', dir: 'desc' });
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  // add-holding form
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [picked, setPicked] = useState(null); // { symbol, name, isin, exchange }
  const [avgCost, setAvgCost] = useState('');
  const [qty, setQty] = useState('');
  const [adding, setAdding] = useState(false);
  const searchAbort = useRef(null);
  const noticeTimer = useRef(null);

  const flashNotice = (msg) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4500);
  };
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  // Full (re)load — replaces all rows from the server. Used on mount and after
  // add / remove / edit so server values are authoritative.
  const loadHoldings = useCallback(async (signal) => {
    try {
      const res = await fetchWithAbort(`${API}/api/portfolios/${portfolioId}/holdings`, { signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load portfolio');
      setPortfolio(data.portfolio);
      setHoldings(data.holdings || []);
      setLastRefreshed(new Date());
      setError(null);
    } catch (e) {
      if (e.name === 'AbortError') return;
      setError(e.message);
      setHoldings([]);
    }
  }, [portfolioId]);

  useEffect(() => {
    const controller = new AbortController();
    loadHoldings(controller.signal);
    return () => controller.abort();
  }, [loadHoldings]);

  // Price-only refresh — merges fresh LTP / previous close into existing rows by
  // id, leaving the user's avg cost / quantity untouched. Used by the button and
  // the 30s interval so an in-progress edit is never clobbered.
  const refreshPrices = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetchWithAbort(`${API}/api/portfolios/${portfolioId}/holdings`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Refresh failed');
      const priceById = {};
      (data.holdings || []).forEach(h => { priceById[h.id] = h; });
      setHoldings(prev => (prev || []).map(h => {
        const fresh = priceById[h.id];
        return fresh ? { ...h, ltp: fresh.ltp, previousClose: fresh.previousClose, token: fresh.token } : h;
      }));
      setLastRefreshed(new Date());
      setError(null);
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
    } finally {
      setRefreshing(false);
    }
  }, [portfolioId]);

  useEffect(() => {
    const t = setInterval(() => { refreshPrices(); }, PRICE_REFRESH_MS);
    return () => clearInterval(t);
  }, [refreshPrices]);

  // Instrument search (debounced) for the add box.
  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      if (searchAbort.current) searchAbort.current.abort();
      const controller = new AbortController();
      searchAbort.current = controller;
      try {
        const res = await fetchWithAbort(`${API}/api/search-instruments?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal });
        const data = await res.json();
        setResults(data.results || []);
      } catch (e) { if (e.name !== 'AbortError') setResults([]); }
    }, 220);
    return () => clearTimeout(t);
  }, [query]);

  const addHolding = async () => {
    if (!picked || adding) return;
    setAdding(true);
    const sym = picked.symbol;
    try {
      const res = await fetch(`${API}/api/portfolios/${portfolioId}/holdings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: picked.symbol, name: picked.name, isin: picked.isin, exchange: picked.exchange,
          avgCost: Number(avgCost) || 0, quantity: Number(qty) || 0,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Add failed');
      setPicked(null); setQuery(''); setResults([]); setAvgCost(''); setQty('');
      await loadHoldings();
      flashNotice(data.merged
        ? `Merged into your existing ${sym} position — average cost recalculated.`
        : `Added ${sym} to the portfolio.`);
    } catch (e) { setError(e.message); }
    finally { setAdding(false); }
  };

  // Persist an edited avg cost / quantity (called on blur / Enter).
  const saveHolding = async (id, patch) => {
    try {
      const res = await fetch(`${API}/api/portfolios/${portfolioId}/holdings/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Save failed'); }
      setError(null);
    } catch (e) { setError(e.message); }
  };

  const removeHolding = async (id, symbol) => {
    if (!window.confirm(`Remove ${symbol} from this portfolio?`)) return;
    try {
      const res = await fetch(`${API}/api/portfolios/${portfolioId}/holdings/${id}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Remove failed'); }
      await loadHoldings();
    } catch (e) { setError(e.message); }
  };

  const deletePortfolio = async () => {
    if (!window.confirm(`Delete portfolio "${portfolio?.name}"? This removes the portfolio and all its holdings.`)) return;
    try {
      const res = await fetch(`${API}/api/portfolios/${portfolioId}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Delete failed'); }
      navigate('/virtual');
    } catch (e) { setError(e.message); }
  };

  const renamePortfolio = async () => {
    const name = nameDraft.trim();
    if (!name || name === portfolio?.name) { setEditingName(false); return; }
    try {
      const res = await fetch(`${API}/api/portfolios/${portfolioId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Rename failed');
      setPortfolio(p => ({ ...p, name }));
      setEditingName(false);
    } catch (e) { setError(e.message); }
  };

  // Update a holding's avg cost / quantity locally so derived columns recompute
  // live; the change is persisted on blur via saveHolding().
  const updateField = (id, field, value) => {
    setHoldings(prev => (prev || []).map(h => (h.id === id ? { ...h, [field]: value } : h)));
  };

  const requestSort = (key) => setSortConfig(prev =>
    prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'name' ? 'asc' : 'desc' });

  // ── Derive + totals + sort ──
  const list = holdings || [];
  const totalCurValue = list.reduce((s, h) => s + (h.ltp != null ? (Number(h.ltp) || 0) * (Number(h.quantity) || 0) : 0), 0);
  const derived = list.map(h => deriveRow(h, totalCurValue));
  const totals = derived.reduce((acc, r) => {
    acc.invested += r.invested;
    if (r.curValue != null) { acc.curValue += r.curValue; acc.investedPriced += r.invested; }
    if (r.pnl != null) acc.pnl += r.pnl;
    if (r.dayChgAbs != null) acc.dayChg += r.dayChgAbs;
    return acc;
  }, { invested: 0, curValue: 0, investedPriced: 0, pnl: 0, dayChg: 0 });
  const totalPnlPct = totals.investedPriced > 0 ? (totals.pnl / totals.investedPriced) * 100 : null;
  const prevTotal = totals.curValue - totals.dayChg;
  const totalDayPct = prevTotal > 0 ? (totals.dayChg / prevTotal) * 100 : null;

  const sorted = (() => {
    const { key, dir } = sortConfig;
    if (!key) return derived;
    return [...derived].sort((a, b) => {
      let va = a[key]; let vb = b[key];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
      if (va < vb) return dir === 'asc' ? -1 : 1;
      if (va > vb) return dir === 'asc' ? 1 : -1;
      return 0;
    });
  })();

  const th = { padding: '0.6rem 0.5rem', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.7rem', letterSpacing: '0.4px', textTransform: 'uppercase', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: '#1e293b', zIndex: 2 };
  const td = { padding: '0.55rem 0.5rem', borderBottom: '1px solid rgba(255,255,255,0.04)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
  const editInput = { width: '90px', background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-primary)', padding: '0.3rem 0.45rem', fontSize: '0.82rem', textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

  const sortableTh = (label, key, align = 'right', extra = null) => {
    const active = sortConfig.key === key;
    return (
      <th key={key} onClick={() => requestSort(key)} title={`Sort by ${label}`}
        style={{ ...th, textAlign: align, cursor: 'pointer', userSelect: 'none', ...extra }}>
        {label}
        <span style={{ marginLeft: '4px', opacity: active ? 1 : 0.3 }}>
          {active ? (sortConfig.dir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </th>
    );
  };

  const total = list.length;

  const summaryCard = (label, value, sub, color) => (
    <div className="glass-panel" style={{ padding: '0.9rem 1.1rem', flex: '1 1 180px', minWidth: '160px' }}>
      <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>{label}</div>
      <div style={{ fontSize: '1.25rem', fontWeight: 700, color: color || 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub != null && <div style={{ fontSize: '0.8rem', color: color || 'var(--text-secondary)', marginTop: '0.15rem', fontVariantNumeric: 'tabular-nums' }}>{sub}</div>}
    </div>
  );

  return (
    <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Link to="/virtual" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textDecoration: 'none' }}>← Back to Portfolios</Link>
        {portfolio && (
          <button onClick={deletePortfolio} title="Delete this portfolio"
            style={{ background: 'transparent', border: '1px solid rgba(239,68,68,0.4)', color: '#fca5a5', borderRadius: '8px', padding: '0.35rem 0.8rem', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600 }}>
            Delete portfolio
          </button>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', margin: '0.75rem 0 1.25rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          {editingName ? (
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <input autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') renamePortfolio(); if (e.key === 'Escape') setEditingName(false); }}
                maxLength={60}
                style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', padding: '0.4rem 0.7rem', fontSize: '1.3rem', fontWeight: 700, minWidth: '240px' }} />
              <button onClick={renamePortfolio} style={{ background: 'var(--accent)', color: '#04141f', border: 'none', borderRadius: '8px', padding: '0.45rem 0.9rem', fontWeight: 700, cursor: 'pointer' }}>Save</button>
              <button onClick={() => setEditingName(false)} style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.45rem 0.9rem', cursor: 'pointer' }}>Cancel</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
              <h1 style={{ margin: 0 }}>{portfolio?.name || 'Portfolio'}</h1>
              {portfolio && (
                <button onClick={() => { setNameDraft(portfolio.name); setEditingName(true); }} title="Rename portfolio"
                  style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.2rem 0.55rem', fontSize: '0.72rem', fontWeight: 600 }}>
                  ✎ Edit
                </button>
              )}
            </div>
          )}
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {total} {total === 1 ? 'holding' : 'holdings'}
            {lastRefreshed && ` · prices as of ${lastRefreshed.toLocaleTimeString()}`}
          </span>
        </div>
        <button onClick={refreshPrices} disabled={refreshing} title="Refresh live prices"
          style={{ alignSelf: 'center', background: 'transparent', border: '1px solid var(--accent)', color: 'var(--accent)', borderRadius: '8px', padding: '0.4rem 1rem', cursor: refreshing ? 'wait' : 'pointer', fontSize: '0.82rem', fontWeight: 600 }}>
          {refreshing ? 'Refreshing…' : '↻ Refresh prices'}
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: '1rem', padding: '0.7rem 1rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '8px', color: '#fca5a5', fontSize: '0.85rem' }}>
          {error}
        </div>
      )}

      {notice && (
        <div style={{ marginBottom: '1rem', padding: '0.7rem 1rem', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '8px', color: '#6ee7b7', fontSize: '0.85rem' }}>
          {notice}
        </div>
      )}

      {/* Summary cards */}
      {total > 0 && (
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
          {summaryCard('Invested', fmtMoney(totals.invested))}
          {summaryCard('Current Value', fmtMoney(totals.curValue))}
          {summaryCard('Overall P&L', fmtSignedMoney(totals.pnl), totalPnlPct != null ? fmtPct(totalPnlPct) : null, signColor(totals.pnl))}
          {summaryCard("Day's P&L", fmtSignedMoney(totals.dayChg), totalDayPct != null ? fmtPct(totalDayPct) : null, signColor(totals.dayChg))}
        </div>
      )}

      {/* Add holding. position+z-index lift this panel (and its overflowing
          search dropdown) above the results table, which is a later sibling and
          its own stacking context via the .glass-panel backdrop-filter. */}
      <div className="glass-panel" style={{ padding: '0.9rem 1.1rem', marginBottom: '1rem', display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap', position: 'relative', zIndex: 30 }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Add holding</span>
        {picked ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', background: 'rgba(56,189,248,0.12)', border: '1px solid var(--accent)', borderRadius: '8px', padding: '0.3rem 0.6rem', fontSize: '0.85rem' }}>
            <strong>{picked.symbol}</strong>
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>{picked.exchange}</span>
            <button onClick={() => { setPicked(null); setQuery(''); }} title="Clear" style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.85rem', lineHeight: 1 }}>✕</button>
          </span>
        ) : (
          <div style={{ position: 'relative', minWidth: '240px' }}>
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search instrument…"
              style={{ width: '100%', background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', padding: '0.45rem 0.8rem', fontSize: '0.88rem' }} />
            {results.length > 0 && (
              <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 50, background: 'var(--bg-dark)', border: '1px solid var(--border)', borderRadius: '8px', maxHeight: '300px', overflowY: 'auto', boxShadow: '0 12px 30px rgba(0,0,0,0.4)' }}>
                {results.map(r => (
                  <button key={`${r.exchange}:${r.symbol}`} onClick={() => { setPicked({ symbol: r.symbol, name: r.name, isin: r.isin, exchange: r.exchange }); setResults([]); }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.04)', color: 'var(--text-primary)', padding: '0.5rem 0.8rem', cursor: 'pointer' }}>
                    <span style={{ fontWeight: 700 }}>{r.symbol}</span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginLeft: '0.5rem' }}>{r.exchange}</span>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{r.name}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <input type="number" step="any" min="0" value={avgCost} onChange={e => setAvgCost(e.target.value)} placeholder="Avg cost"
          style={{ ...editInput, width: '110px' }} />
        <input type="number" step="any" min="0" value={qty} onChange={e => setQty(e.target.value)} placeholder="Qty"
          onKeyDown={e => { if (e.key === 'Enter') addHolding(); }}
          style={{ ...editInput, width: '90px' }} />
        <button onClick={addHolding} disabled={!picked || adding || !(Number(qty) > 0)}
          style={{ background: 'var(--accent)', color: '#04141f', border: 'none', borderRadius: '8px', padding: '0.45rem 1.1rem', fontWeight: 700, cursor: (!picked || !(Number(qty) > 0)) ? 'not-allowed' : 'pointer', opacity: (!picked || !(Number(qty) > 0)) ? 0.5 : 1 }}>
          {adding ? 'Adding…' : '+ Add'}
        </button>
      </div>

      {holdings == null ? (
        <p style={{ color: 'var(--text-secondary)' }}>Loading…</p>
      ) : total === 0 ? (
        <div className="glass-panel" style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No holdings yet. Search for an instrument above, enter your average cost and quantity, then Add.
        </div>
      ) : (
        <div className="glass-panel" style={{ padding: '0 1rem 1rem', overflow: 'auto', maxHeight: 'calc(100vh - 180px)' }}>
          <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '0.85rem' }}>
            <thead>
              <tr>
                {sortableTh('Instrument', 'name', 'left', { width: '160px' })}
                {sortableTh('Avg. Cost', 'avgCost', 'right')}
                {sortableTh('LTP', 'ltp', 'right')}
                {sortableTh('Qty.', 'quantity', 'right')}
                {sortableTh('Invested', 'invested', 'right')}
                {sortableTh('Cur. Value', 'curValue', 'right')}
                {sortableTh('Net Chg.', 'netChgPct', 'right')}
                {sortableTh('P&L', 'pnl', 'right')}
                {sortableTh('Day Chg.', 'dayChgPct', 'right')}
                {sortableTh('Allocation', 'allocation', 'right')}
                <th style={{ ...th, textAlign: 'center' }} />
              </tr>
            </thead>
            <tbody>
              {sorted.map(r => (
                <tr key={r.id}>
                  <td style={{ ...td, textAlign: 'left', cursor: r.token ? 'pointer' : 'default', width: '160px', maxWidth: '160px' }}
                    onClick={() => r.token && navigate(`/instrument/${r.token}?symbol=${encodeURIComponent(r.symbol)}`)}>
                    <div title={r.name} style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.symbol}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</div>
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <input type="number" step="any" min="0" value={r.avgCost}
                      onChange={e => updateField(r.id, 'avgCost', e.target.value)}
                      onBlur={e => saveHolding(r.id, { avgCost: Number(e.target.value) || 0 })}
                      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                      style={editInput} />
                  </td>
                  <td style={{ ...td, textAlign: 'right', color: 'var(--text-primary)' }}>{r.ltp == null ? '—' : fmtMoney(r.ltp)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <input type="number" step="any" min="0" value={r.quantity}
                      onChange={e => updateField(r.id, 'quantity', e.target.value)}
                      onBlur={e => saveHolding(r.id, { quantity: Number(e.target.value) || 0 })}
                      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                      style={{ ...editInput, width: '80px' }} />
                  </td>
                  <td style={{ ...td, textAlign: 'right', color: 'var(--text-primary)' }}>{fmtMoney(r.invested)}</td>
                  <td style={{ ...td, textAlign: 'right', color: 'var(--text-primary)' }}>{fmtMoney(r.curValue)}</td>
                  <td style={{ ...td, textAlign: 'right', color: signColor(r.netChgPct) }}>{fmtPct(r.netChgPct)}</td>
                  <td style={{ ...td, textAlign: 'right', color: signColor(r.pnl) }}>{fmtSignedMoney(r.pnl)}</td>
                  <td style={{ ...td, textAlign: 'right', color: signColor(r.dayChgAbs) }}>
                    {fmtSignedMoney(r.dayChgAbs)}
                    {r.dayChgPct != null && <div style={{ fontSize: '0.7rem' }}>{fmtPct(r.dayChgPct)}</div>}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {r.allocation == null ? '—' : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', justifyContent: 'flex-end' }}>
                        <div style={{ width: '46px', height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                          <div style={{ width: `${Math.min(100, r.allocation)}%`, height: '100%', background: 'var(--accent)' }} />
                        </div>
                        <span style={{ color: 'var(--text-primary)', minWidth: '42px' }}>{r.allocation.toFixed(1)}%</span>
                      </div>
                    )}
                  </td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    <button onClick={() => removeHolding(r.id, r.symbol)} title="Remove from portfolio"
                      style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.9rem' }}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td style={{ ...td, textAlign: 'left', fontWeight: 700, color: 'var(--text-primary)', position: 'sticky', bottom: 0, background: '#1e293b' }}>Total</td>
                <td style={{ ...td, position: 'sticky', bottom: 0, background: '#1e293b' }} />
                <td style={{ ...td, position: 'sticky', bottom: 0, background: '#1e293b' }} />
                <td style={{ ...td, position: 'sticky', bottom: 0, background: '#1e293b' }} />
                <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: 'var(--text-primary)', position: 'sticky', bottom: 0, background: '#1e293b' }}>{fmtMoney(totals.invested)}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: 'var(--text-primary)', position: 'sticky', bottom: 0, background: '#1e293b' }}>{fmtMoney(totals.curValue)}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: signColor(totalPnlPct), position: 'sticky', bottom: 0, background: '#1e293b' }}>{fmtPct(totalPnlPct)}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: signColor(totals.pnl), position: 'sticky', bottom: 0, background: '#1e293b' }}>{fmtSignedMoney(totals.pnl)}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: signColor(totals.dayChg), position: 'sticky', bottom: 0, background: '#1e293b' }}>{fmtSignedMoney(totals.dayChg)}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: 'var(--text-primary)', position: 'sticky', bottom: 0, background: '#1e293b' }}>100%</td>
                <td style={{ ...td, position: 'sticky', bottom: 0, background: '#1e293b' }} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
