import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchWithAbort } from '../hooks/useFetchWithAbort';

// Unified instrument search: India (Kite search_instruments) + US (Yahoo, via
// /api/us/search) queried in parallel. Debounced 200ms. India rows navigate to
// /instrument/:token, US rows to /us/:symbol. One source failing doesn't hide
// the other (Promise.allSettled). The standalone US-only <UsSearch> is used
// elsewhere (UsIndices) and is left untouched.
function InstrumentSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const containerRef = useRef(null);
  const abortRef = useRef(null);

  // Debounced fetch. When the query shrinks below 2 chars we clear stale
  // results — the eslint set-state-in-effect rule flags this, but the alternative
  // (deriving from a prev-results ref) is harder to read for a clear win.
  useEffect(() => {
    if (query.trim().length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      setLoading(false);
      return;
    }
    const timer = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const q = encodeURIComponent(query.trim());
      setLoading(true);
      // Query India + US in parallel; tag each row's market so selection can
      // route to the right page. allSettled → one source down still shows the other.
      const grab = async (url, market) => {
        const res = await fetchWithAbort(url, { signal: controller.signal });
        const data = await res.json();
        return (data.results || []).map(r => ({ ...r, market }));
      };
      const settled = await Promise.allSettled([
        grab(`/api/search-instruments?q=${q}`, 'IN'),
        grab(`/api/us/search?q=${q}`, 'US'),
      ]);
      if (controller.signal.aborted) return;
      // India first (primary market), then US.
      const merged = settled.flatMap(s => (s.status === 'fulfilled' ? s.value : []));
      setResults(merged);
      setActiveIdx(0);
      setLoading(false);
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const select = useCallback((row) => {
    if (!row) return;
    if (row.market === 'US') {
      if (!row.symbol) return;
    } else if (!row.token) return;
    setOpen(false);
    setQuery('');
    setResults([]);
    if (row.market === 'US') navigate(`/us/${encodeURIComponent(row.symbol)}`);
    else navigate(`/instrument/${row.token}?symbol=${encodeURIComponent(row.symbol)}`);
  }, [navigate]);

  const onKeyDown = (e) => {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); select(results[activeIdx]); }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '260px' }}>
      <input
        type="text"
        value={query}
        placeholder="Search stocks (India + US)…"
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        style={{
          width: '100%',
          padding: '0.5rem 0.8rem',
          fontSize: '0.85rem',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          color: 'var(--text-primary)',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
      {open && query.trim().length >= 2 && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 6px)',
          left: 0,
          right: 0,
          background: '#0f0f1e',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          maxHeight: '380px',
          overflowY: 'auto',
          // Beats sticky table headers, modal overlays (9999), and momentum
          // popovers on SectorIndices. Any future modal MUST stay below this.
          zIndex: 99999,
        }}>
          {loading && results.length === 0 && (
            <div style={{ padding: '0.6rem 0.8rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Searching…</div>
          )}
          {!loading && results.length === 0 && (
            <div style={{ padding: '0.6rem 0.8rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>No matches</div>
          )}
          {results.map((row, idx) => (
            <div
              key={`${row.market}:${row.exchange}:${row.symbol}`}
              onMouseDown={(e) => { e.preventDefault(); select(row); }}
              onMouseEnter={() => setActiveIdx(idx)}
              style={{
                padding: '0.5rem 0.8rem',
                cursor: 'pointer',
                background: idx === activeIdx ? 'rgba(56,189,248,0.08)' : 'transparent',
                borderBottom: idx < results.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.15rem',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.4rem' }}>
                <span style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.symbol}
                  {row.type === 'ETF' && <span style={{ marginLeft: '0.4rem', fontSize: '0.6rem', fontWeight: 700, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: '3px', padding: '0 0.25rem' }}>ETF</span>}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{row.exchange}</span>
                  <span style={{
                    fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.5px',
                    color: row.market === 'US' ? '#fbbf24' : '#34d399',
                    border: `1px solid ${row.market === 'US' ? 'rgba(251,191,36,0.5)' : 'rgba(52,211,153,0.5)'}`,
                    borderRadius: '3px', padding: '0 0.25rem',
                  }}>{row.market === 'US' ? 'US' : 'IN'}</span>
                </span>
              </div>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default InstrumentSearch;
