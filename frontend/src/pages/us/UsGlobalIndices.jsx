import { useState, useEffect, useMemo } from 'react';
import { fetchWithAbort } from '../../hooks/useFetchWithAbort';

// Global markets performance — major world indices (Americas / Europe /
// Asia-Pacific) via Yahoo Finance. Rendered as a tab inside US Indices.

const REGIONS = ['Americas', 'Europe', 'Asia-Pacific'];
const RET_COLS = [
  { key: 'change1D', label: '1D' },
  { key: 'ret1W', label: '1W' },
  { key: 'ret1M', label: '1M' },
  { key: 'ret3M', label: '3M' },
  { key: 'ret6M', label: '6M' },
  { key: 'retYTD', label: 'YTD' },
  { key: 'ret1Y', label: '1Y' },
];
const fmtPct = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const pctColor = (v) => (v == null ? 'var(--text-secondary)' : v >= 0 ? 'var(--success)' : 'var(--danger)');
const fmtPrice = (v, ccy) => (v == null ? '—' : `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}${ccy ? ` ${ccy}` : ''}`);

function RegionTable({ region, rows }) {
  const [sort, setSort] = useState({ key: null, dir: 'desc' });
  const sorted = useMemo(() => {
    if (!sort.key) return rows;
    const arr = [...rows];
    arr.sort((a, b) => {
      const av = sort.key === 'label' ? a.label : a[sort.key];
      const bv = sort.key === 'label' ? b.label : b[sort.key];
      if (av == null) return 1; if (bv == null) return -1;
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [rows, sort]);
  const th = (key, label, align = 'right') => (
    <th key={key} onClick={() => setSort(s => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}
      style={{ cursor: 'pointer', textAlign: align, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-secondary)', padding: '0.5rem 0.8rem', whiteSpace: 'nowrap', userSelect: 'none' }}>
      {label}{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );
  const td = { textAlign: 'right', fontSize: '0.85rem', padding: '0.5rem 0.8rem', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
  return (
    <div style={{ marginBottom: '1.75rem' }}>
      <h3 style={{ margin: '0 0 0.6rem' }}>{region}</h3>
      <div className="glass-panel" style={{ padding: '0.4rem 0.4rem 0.6rem', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
            {th('label', 'Index', 'left')}
            <th style={{ textAlign: 'right', fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--text-secondary)', padding: '0.5rem 0.8rem' }}>Last</th>
            {RET_COLS.map(c => th(c.key, c.label))}
          </tr></thead>
          <tbody>
            {sorted.map(r => (
              <tr key={r.symbol} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <td style={{ ...td, textAlign: 'left' }}>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{r.label}</span>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{r.country}</div>
                </td>
                <td style={{ ...td, color: 'var(--text-secondary)' }}>{fmtPrice(r.price, r.currency)}</td>
                {RET_COLS.map(c => (
                  <td key={c.key} style={{ ...td, color: pctColor(r[c.key]), fontWeight: 600 }}>{fmtPct(r[c.key])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function UsGlobalIndices() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const c = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort('/api/us/global-indices', { signal: c.signal });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load');
        setRows(data.rows || []);
      } catch (e) { if (e.name !== 'AbortError') setError(e.message); }
    })();
    return () => c.abort();
  }, []);

  if (error) return <div className="glass-panel" style={{ padding: '1.5rem', color: 'var(--danger)' }}>Failed to load global indices: {error}</div>;
  if (!rows) return <div className="loader" />;

  return (
    <div>
      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 0 }}>
        Major world indices via Yahoo Finance. Returns in each index's local currency; click a column to sort.
      </p>
      {REGIONS.map(region => {
        const regionRows = rows.filter(r => r.region === region);
        if (regionRows.length === 0) return null;
        return <RegionTable key={region} region={region} rows={regionRows} />;
      })}
    </div>
  );
}
