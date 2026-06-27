import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchWithAbort } from '../hooks/useFetchWithAbort';

// US ticker/name search backed by Yahoo (via /api/us/search).
// Debounced 200ms; navigates to /us/:symbol on selection.
function UsSearch({ width = '260px', placeholder = 'Search US stocks…', onSelect }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const containerRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]); setLoading(false); return;
    }
    const timer = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      try {
        const res = await fetchWithAbort(`/api/us/search?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal });
        const data = await res.json();
        if (!controller.signal.aborted) { setResults(data.results || []); setActiveIdx(0); setLoading(false); }
      } catch (e) {
        if (e.name !== 'AbortError') setLoading(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const handler = (e) => { if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const select = useCallback((row) => {
    if (!row?.symbol) return;
    setOpen(false); setQuery(''); setResults([]);
    if (onSelect) onSelect(row);
    else navigate(`/us/${encodeURIComponent(row.symbol)}`);
  }, [navigate, onSelect]);

  const onKeyDown = (e) => {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); select(results[activeIdx]); }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  return (
    <div ref={containerRef} style={{ position: 'relative', width }}>
      <input
        type="text"
        value={query}
        placeholder={placeholder}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        style={{
          width: '100%', padding: '0.5rem 0.8rem', fontSize: '0.85rem',
          background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
          borderRadius: '8px', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box',
        }}
      />
      {open && query.trim().length >= 2 && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0,
          background: '#0f0f1e', border: '1px solid var(--border)', borderRadius: '8px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)', maxHeight: '380px', overflowY: 'auto', zIndex: 99999,
        }}>
          {loading && results.length === 0 && (
            <div style={{ padding: '0.6rem 0.8rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Searching…</div>
          )}
          {!loading && results.length === 0 && (
            <div style={{ padding: '0.6rem 0.8rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>No matches</div>
          )}
          {results.map((row, idx) => (
            <div
              key={`${row.exchange}:${row.symbol}`}
              onMouseDown={(e) => { e.preventDefault(); select(row); }}
              onMouseEnter={() => setActiveIdx(idx)}
              style={{
                padding: '0.5rem 0.8rem', cursor: 'pointer',
                background: idx === activeIdx ? 'rgba(56,189,248,0.08)' : 'transparent',
                borderBottom: idx < results.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                display: 'flex', flexDirection: 'column', gap: '0.15rem',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                  {row.symbol}
                  {row.type === 'ETF' && <span style={{ marginLeft: '0.4rem', fontSize: '0.6rem', fontWeight: 700, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: '3px', padding: '0 0.25rem' }}>ETF</span>}
                </span>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{row.exchange}</span>
              </div>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default UsSearch;
