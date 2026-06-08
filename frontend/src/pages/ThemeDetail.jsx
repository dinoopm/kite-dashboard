import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { fetchWithAbort } from '../hooks/useFetchWithAbort';
import TechnicalAlertsPanel from '../components/alerts/TechnicalAlertsPanel';
import { breakoutRank, breakoutLabel } from '../lib/breakout';

const API = import.meta.env.VITE_API_URL || '';

// ── Per-stock calc helpers (replicated from SectorDetail; the originals are
//    not exported). Keep behaviour identical so the table reads the same. ──
function calculateHistoricalReturns(series, currentPrice) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  const nowIST = new Date(`${y}-${m}-${d}T00:00:00Z`);
  const dates = series.map(c => new Date(c.date).getTime());
  const getPriceAtDate = (targetDate) => {
    if (dates.length === 0) return 0;
    const target = targetDate.getTime();
    let lo = 0, hi = dates.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] < target) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(dates[lo - 1] - target) <= Math.abs(dates[lo] - target)) return series[lo - 1].close;
    return series[lo].close;
  };
  const back = (fn) => { const dt = new Date(nowIST); fn(dt); return dt; };
  const calcPct = (oldPrice) => (!oldPrice ? 0 : ((currentPrice - oldPrice) / oldPrice) * 100);
  return {
    '1W': calcPct(getPriceAtDate(back(dt => dt.setDate(nowIST.getDate() - 7)))),
    '1M': calcPct(getPriceAtDate(back(dt => dt.setMonth(nowIST.getMonth() - 1)))),
    '3M': calcPct(getPriceAtDate(back(dt => dt.setMonth(nowIST.getMonth() - 3)))),
    '6M': calcPct(getPriceAtDate(back(dt => dt.setMonth(nowIST.getMonth() - 6)))),
    '1Y': calcPct(getPriceAtDate(back(dt => dt.setFullYear(nowIST.getFullYear() - 1)))),
    '2Y': calcPct(getPriceAtDate(back(dt => dt.setFullYear(nowIST.getFullYear() - 2)))),
    '3Y': calcPct(getPriceAtDate(back(dt => dt.setFullYear(nowIST.getFullYear() - 3)))),
  };
}

function computeRsi14(sorted) {
  if (!sorted || sorted.length < 15) return null;
  const closes = sorted.map(c => c.close);
  const changes = closes.slice(1).map((v, i) => v - closes[i]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < 14; i++) { if (changes[i] > 0) avgGain += changes[i]; else avgLoss += Math.abs(changes[i]); }
  avgGain /= 14; avgLoss /= 14;
  for (let i = 14; i < changes.length; i++) {
    avgGain = (avgGain * 13 + (changes[i] > 0 ? changes[i] : 0)) / 14;
    avgLoss = (avgLoss * 13 + (changes[i] < 0 ? Math.abs(changes[i]) : 0)) / 14;
  }
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(1));
}

function computeSMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

const RET_COLS = ['1D', '1W', '1M', '3M', '6M', '1Y', '2Y', '3Y'];
const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const pctColor = (v) => (v == null ? 'var(--text-secondary)' : v > 0 ? '#10b981' : v < 0 ? '#ef4444' : 'var(--text-secondary)');
const smaBadge = (above) => above == null
  ? <span style={{ color: 'var(--text-secondary)' }}>—</span>
  : <span style={{ color: above ? '#10b981' : '#ef4444' }}>{above ? '▲' : '▼'}</span>;
// Breakout indicator — longest horizon at a new high (3Y…1M), or Near / below.
const breakoutBadge = (v) => {
  if (v == null) return <span style={{ color: 'var(--text-secondary)' }}>—</span>;
  const { text, color } = breakoutLabel(v);
  const title = v >= 2 ? `Breakout — closed at a new ${text.replace('🚀 ', '')} high`
    : v === 1 ? 'Near breakout — within 1.5% of the 1-month high' : 'Below the 1-month high';
  return <span title={title} style={{ color, fontWeight: v >= 1 ? 700 : 400 }}>{text}</span>;
};

export default function ThemeDetail() {
  const { themeId } = useParams();
  const navigate = useNavigate();
  const [theme, setTheme] = useState(null);
  const [constituents, setConstituents] = useState(null); // null = loading
  const [stockData, setStockData] = useState([]);
  const [loadedCount, setLoadedCount] = useState(0);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('stocks');
  // Stocks-table sort. key=null keeps the theme's natural (insertion) order.
  const [sortConfig, setSortConfig] = useState({ key: null, dir: 'desc' });
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  // add-instrument search
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [adding, setAdding] = useState(false);
  const searchAbort = useRef(null);

  // alerts tab
  const [alerts, setAlerts] = useState(null);
  const [alertsSummary, setAlertsSummary] = useState(null);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertsError, setAlertsError] = useState(null);
  const [alertsLastUpdated, setAlertsLastUpdated] = useState(null);

  const loadConstituents = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/themes/${themeId}/constituents`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load theme');
      setTheme(data.theme);
      setConstituents(data.constituents || []);
      setError(null);
    } catch (e) {
      setError(e.message);
      setConstituents([]);
    }
  }, [themeId]);

  useEffect(() => { loadConstituents(); }, [loadConstituents]);

  // Progressive table load: live quotes for price/1D, then per-token full
  // history for the multi-period returns, RSI and SMA badges.
  useEffect(() => {
    if (!constituents || constituents.length === 0) { setStockData([]); setLoadedCount(0); return; }
    const controller = new AbortController();
    const { signal } = controller;
    (async () => {
      const instruments = constituents.filter(c => c.token).map(c => c.key);
      let quotes = {};
      if (instruments.length) {
        try {
          const qRes = await fetchWithAbort(`${API}/api/quotes`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instruments }), signal,
          });
          const qRaw = await qRes.json();
          quotes = qRaw?.content?.[0]?.text ? JSON.parse(qRaw.content[0].text) : {};
        } catch (e) { if (e.name === 'AbortError' || signal.aborted) return; }
      }
      if (signal.aborted) return;

      const initial = constituents.map(c => {
        const q = quotes[c.key];
        const price = q?.last_price ?? 0;
        const prevClose = q?.ohlc?.close ?? price;
        const change1D = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
        return {
          ...c, price, '1D': change1D,
          '1W': null, '1M': null, '3M': null, '6M': null, '1Y': null, '2Y': null, '3Y': null,
          rsi14: null, aboveSma20: null, aboveSma200: null, breakout: null, histLoaded: false,
        };
      });
      setStockData(initial);
      setLoadedCount(0);

      for (const c of constituents) {
        if (signal.aborted) break;
        if (!c.token) continue;
        try {
          const hRes = await fetchWithAbort(`${API}/api/historical-full/${c.token}`, { signal });
          const hData = await hRes.json();
          let arr = null;
          if (hData?.content?.[0]?.text) {
            try { const p = JSON.parse(hData.content[0].text); if (Array.isArray(p)) arr = p; } catch { /* ignore */ }
          }
          if (arr?.length && !signal.aborted) {
            const sorted = [...arr].sort((a, b) => a.date.localeCompare(b.date));
            const price = sorted[sorted.length - 1]?.close ?? 0;
            const returns = calculateHistoricalReturns(sorted, price);
            const rsi14 = computeRsi14(sorted);
            const closes = sorted.map(cc => cc.close);
            const sma20 = computeSMA(closes, 20);
            const sma200 = computeSMA(closes, 200);
            const lastClose = closes[closes.length - 1];
            const prevDayClose = sorted[sorted.length - 2]?.close;
            setStockData(prev => prev.map(s => s.key === c.key ? {
              ...s, ...returns,
              price: s.price || price,
              '1D': (!s.price && prevDayClose) ? ((price - prevDayClose) / prevDayClose) * 100 : s['1D'],
              rsi14,
              aboveSma20: sma20 != null ? lastClose >= sma20 : null,
              aboveSma200: sma200 != null ? lastClose >= sma200 : null,
              breakout: breakoutRank(sorted),
              histLoaded: true,
            } : s));
            setLoadedCount(n => n + 1);
          }
        } catch (e) { if (e.name === 'AbortError' || signal.aborted) break; }
        if (signal.aborted) break;
        await new Promise(r => setTimeout(r, 150));
      }
    })();
    return () => controller.abort();
  }, [constituents]);

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

  const addInstrument = async (row) => {
    if (adding) return;
    setAdding(true);
    try {
      const res = await fetch(`${API}/api/themes/${themeId}/instruments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: row.symbol, name: row.name, isin: row.isin, exchange: row.exchange }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 409) throw new Error(data.error || 'Add failed');
      setQuery(''); setResults([]);
      await loadConstituents();
    } catch (e) { setError(e.message); }
    finally { setAdding(false); }
  };

  const removeInstrument = async (instrumentId, name) => {
    if (!instrumentId) return;
    if (!window.confirm(`Remove ${name} from this theme?`)) return;
    try {
      const res = await fetch(`${API}/api/themes/${themeId}/instruments/${instrumentId}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Remove failed'); }
      await loadConstituents();
    } catch (e) { setError(e.message); }
  };

  const deleteTheme = async () => {
    if (!window.confirm(`Delete theme "${theme?.name}"? This removes the theme and all its instruments.`)) return;
    try {
      const res = await fetch(`${API}/api/themes/${themeId}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Delete failed'); }
      navigate('/basket');
    } catch (e) { setError(e.message); }
  };

  const renameTheme = async () => {
    const name = nameDraft.trim();
    if (!name || name === theme?.name) { setEditingName(false); return; }
    try {
      const res = await fetch(`${API}/api/themes/${themeId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Rename failed');
      setTheme(t => ({ ...t, name }));
      setEditingName(false);
    } catch (e) { setError(e.message); }
  };

  // Technical Alerts tab — lazy load when opened.
  const loadAlerts = useCallback(async (signal) => {
    setAlertsLoading(true); setAlertsError(null);
    try {
      const res = await fetchWithAbort(`${API}/api/themes/${themeId}/alerts`, { signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load alerts');
      setAlerts(data.alerts || []);
      setAlertsSummary(data.summary || null);
      setAlertsLastUpdated(new Date());
    } catch (e) { if (e.name !== 'AbortError') setAlertsError(e.message); }
    finally { setAlertsLoading(false); }
  }, [themeId]);

  useEffect(() => {
    if (activeTab !== 'alerts') return;
    const controller = new AbortController();
    loadAlerts(controller.signal);
    return () => controller.abort();
  }, [activeTab, loadAlerts]);

  const total = constituents?.length || 0;
  const th = { padding: '0.6rem 0.6rem', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.7rem', letterSpacing: '0.4px', textTransform: 'uppercase', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
  const td = { padding: '0.7rem 0.6rem', borderBottom: '1px solid rgba(255,255,255,0.04)', whiteSpace: 'nowrap' };

  // Click a header to sort; click again to flip direction. Text sorts ascending
  // by default, everything else descending (high-to-low). Nulls always sink.
  const requestSort = (key) => setSortConfig(prev =>
    prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'name' ? 'asc' : 'desc' });

  const sortedStockData = (() => {
    if (!sortConfig.key) return stockData;
    const { key, dir } = sortConfig;
    return [...stockData].sort((a, b) => {
      let va = a[key];
      let vb = b[key];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
      if (va < vb) return dir === 'asc' ? -1 : 1;
      if (va > vb) return dir === 'asc' ? 1 : -1;
      return 0;
    });
  })();

  const sortableTh = (label, key, align = 'right') => {
    const active = sortConfig.key === key;
    return (
      <th
        key={key}
        onClick={() => requestSort(key)}
        title={`Sort by ${label}`}
        style={{ ...th, textAlign: align, cursor: 'pointer', userSelect: 'none' }}
      >
        {label}
        <span style={{ marginLeft: '4px', opacity: active ? 1 : 0.3 }}>
          {active ? (sortConfig.dir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </th>
    );
  };

  return (
    <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Link to="/basket" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textDecoration: 'none' }}>← Back to Baskets</Link>
        {theme && (
          <button
            onClick={deleteTheme}
            title="Delete this theme"
            style={{ background: 'transparent', border: '1px solid rgba(239,68,68,0.4)', color: '#fca5a5', borderRadius: '8px', padding: '0.35rem 0.8rem', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600 }}
          >
            Delete theme
          </button>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', margin: '0.75rem 0 1.25rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          {editingName ? (
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                autoFocus
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') renameTheme(); if (e.key === 'Escape') setEditingName(false); }}
                maxLength={60}
                style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', padding: '0.4rem 0.7rem', fontSize: '1.3rem', fontWeight: 700, minWidth: '240px' }}
              />
              <button onClick={renameTheme} style={{ background: 'var(--accent)', color: '#04141f', border: 'none', borderRadius: '8px', padding: '0.45rem 0.9rem', fontWeight: 700, cursor: 'pointer' }}>Save</button>
              <button onClick={() => setEditingName(false)} style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.45rem 0.9rem', cursor: 'pointer' }}>Cancel</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
              <h1 style={{ margin: 0 }}>{theme?.name || 'Theme'}</h1>
              {theme && (
                <button
                  onClick={() => { setNameDraft(theme.name); setEditingName(true); }}
                  title="Rename theme"
                  style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.2rem 0.55rem', fontSize: '0.72rem', fontWeight: 600 }}
                >
                  ✎ Edit
                </button>
              )}
            </div>
          )}
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {total} {total === 1 ? 'instrument' : 'instruments'}
            {activeTab === 'stocks' && total > 0 && ` · ${loadedCount}/${total} loaded`}
          </span>
        </div>

        {/* Add instrument */}
        <div style={{ position: 'relative', minWidth: '280px' }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search to add an instrument…"
            style={{ width: '100%', background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', padding: '0.55rem 0.9rem', fontSize: '0.9rem' }}
          />
          {results.length > 0 && (
            <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 50, background: 'var(--bg-dark)', border: '1px solid var(--border)', borderRadius: '8px', maxHeight: '320px', overflowY: 'auto', boxShadow: '0 12px 30px rgba(0,0,0,0.4)' }}>
              {results.map(r => (
                <button
                  key={`${r.exchange}:${r.symbol}`}
                  onClick={() => addInstrument(r)}
                  disabled={adding}
                  style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.04)', color: 'var(--text-primary)', padding: '0.55rem 0.8rem', cursor: 'pointer' }}
                >
                  <span style={{ fontWeight: 700 }}>{r.symbol}</span>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginLeft: '0.5rem' }}>{r.exchange}</span>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{r.name}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && (
        <div style={{ marginBottom: '1rem', padding: '0.7rem 1rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '8px', color: '#fca5a5', fontSize: '0.85rem' }}>
          {error}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '1.5rem', borderBottom: '1px solid var(--border)', marginBottom: '1rem' }}>
        {[['stocks', 'Stocks'], ['alerts', 'Technical Alerts']].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            style={{ background: 'transparent', border: 'none', borderBottom: activeTab === key ? '2px solid var(--accent)' : '2px solid transparent', color: activeTab === key ? 'var(--text-primary)' : 'var(--text-secondary)', padding: '0.6rem 0.2rem', cursor: 'pointer', fontWeight: activeTab === key ? 700 : 500, fontSize: '0.95rem' }}
          >
            {label}
          </button>
        ))}
      </div>

      {constituents == null ? (
        <p style={{ color: 'var(--text-secondary)' }}>Loading…</p>
      ) : total === 0 ? (
        <div className="glass-panel" style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No instruments yet. Use the search box above to add some.
        </div>
      ) : activeTab === 'stocks' ? (
        <div className="glass-panel" style={{ padding: '1rem', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '0.85rem' }}>
            <thead>
              <tr>
                {sortableTh('Name', 'name', 'left')}
                {sortableTh('Price', 'price', 'right')}
                {RET_COLS.map(c => sortableTh(c, c, 'right'))}
                {sortableTh('RSI', 'rsi14', 'right')}
                {sortableTh('SMA 20', 'aboveSma20', 'center')}
                {sortableTh('SMA 200', 'aboveSma200', 'center')}
                {sortableTh('Breakout', 'breakout', 'center')}
                <th style={{ ...th, textAlign: 'center' }} />
              </tr>
            </thead>
            <tbody>
              {sortedStockData.map(s => (
                <tr key={s.key}>
                  <td style={{ ...td, textAlign: 'left', cursor: s.token ? 'pointer' : 'default' }}
                    onClick={() => s.token && navigate(`/instrument/${s.token}?symbol=${encodeURIComponent(s.symbol)}`)}>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{s.name}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{s.symbol}</div>
                  </td>
                  <td style={{ ...td, textAlign: 'right', color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                    {s.price ? `₹${s.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
                  </td>
                  {RET_COLS.map(c => (
                    <td key={c} style={{ ...td, textAlign: 'right', color: pctColor(s[c]), fontVariantNumeric: 'tabular-nums' }}>
                      {fmtPct(s[c])}
                    </td>
                  ))}
                  <td style={{ ...td, textAlign: 'right', color: 'var(--text-primary)' }}>{s.rsi14 == null ? '—' : s.rsi14}</td>
                  <td style={{ ...td, textAlign: 'center' }}>{smaBadge(s.aboveSma20)}</td>
                  <td style={{ ...td, textAlign: 'center' }}>{smaBadge(s.aboveSma200)}</td>
                  <td style={{ ...td, textAlign: 'center' }}>{breakoutBadge(s.breakout)}</td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    <button onClick={() => removeInstrument(s.instrumentId, s.symbol)} title="Remove from theme"
                      style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.9rem' }}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        /* Technical Alerts tab */
        alertsLoading && (!alerts || alerts.length === 0) ? (
          <p style={{ color: 'var(--text-secondary)' }}>Computing technical alerts… (loads after the Stocks tab warms each stock's history)</p>
        ) : alertsError ? (
          <div style={{ padding: '0.7rem 1rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '8px', color: '#fca5a5', fontSize: '0.85rem' }}>{alertsError}</div>
        ) : (
          <TechnicalAlertsPanel alerts={alerts || []} summary={alertsSummary} lastUpdated={alertsLastUpdated} />
        )
      )}
    </div>
  );
}
