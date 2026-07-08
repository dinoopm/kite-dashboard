import { useState, useEffect, useMemo } from 'react';
import { fetchWithAbort } from '../../hooks/useFetchWithAbort';

// Global markets performance — major world indices (Americas / Europe /
// Asia-Pacific / Middle East & Africa) via Yahoo Finance. Rendered as a tab
// inside US Indices.

const REGIONS = ['Americas', 'Europe', 'Asia-Pacific', 'Middle East & Africa'];
const RET_COLS = [
  { key: 'change1D', label: '1D' },
  { key: 'ret1W', label: '1W' },
  { key: 'ret1M', label: '1M' },
  { key: 'ret3M', label: '3M' },
  { key: 'ret6M', label: '6M' },
  { key: 'retYTD', label: 'YTD' },
  { key: 'ret1Y', label: '1Y' },
  { key: 'ret3Y', label: '3Y' },
  { key: 'ret4Y', label: '4Y' },
  { key: 'ret5Y', label: '5Y' },
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

// Heatmap cell color: green/red with intensity scaled to the 90th percentile
// of |return| across all indices for the selected period — so one outlier
// (a hyperinflation index on 5Y, say) doesn't wash every other cell grey.
function heatColor(v, cap) {
  if (v == null) return { background: 'rgba(255,255,255,0.03)', color: 'var(--text-secondary)' };
  const t = Math.min(1, Math.abs(v) / (cap || 1));
  const alpha = 0.10 + 0.55 * t;
  return {
    background: v >= 0 ? `rgba(16,185,129,${alpha})` : `rgba(239,68,68,${alpha})`,
    color: '#fff',
  };
}

function Heatmap({ rows, colKey, label }) {
  const cap = useMemo(() => {
    const vals = rows.map(r => Math.abs(r[colKey])).filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
    if (!vals.length) return 1;
    return vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.9))] || 1;
  }, [rows, colKey]);

  return (
    <div>
      {REGIONS.map(region => {
        const regionRows = rows.filter(r => r.region === region);
        if (!regionRows.length) return null;
        // Within each region, strongest movers first for scanability.
        const ordered = [...regionRows].sort((a, b) => (b[colKey] ?? -Infinity) - (a[colKey] ?? -Infinity));
        return (
          <div key={region} style={{ marginBottom: '1.5rem' }}>
            <h3 style={{ margin: '0 0 0.6rem' }}>{region}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '0.5rem' }}>
              {ordered.map(r => {
                const v = r[colKey];
                const c = heatColor(v, cap);
                return (
                  <div key={r.symbol} title={`${r.label} (${r.country}) · ${label}: ${fmtPct(v)} · last ${fmtPrice(r.price, r.currency)}`}
                    style={{ ...c, borderRadius: '8px', padding: '0.6rem 0.7rem', minHeight: '62px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontSize: '0.78rem', fontWeight: 700, lineHeight: 1.25 }}>{r.label}</div>
                      <div style={{ fontSize: '0.62rem', opacity: 0.75 }}>{r.country}</div>
                    </div>
                    <div style={{ fontSize: '0.95rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtPct(v)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function UsGlobalIndices() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState('table'); // 'table' (default) | 'heatmap'
  const [heatKey, setHeatKey] = useState('change1D');

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

  const pill = (active) => ({
    padding: '0.3rem 0.75rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 700,
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    background: active ? 'rgba(56,189,248,0.12)' : 'transparent',
    color: active ? 'var(--accent)' : 'var(--text-secondary)',
  });
  const heatLabel = RET_COLS.find(c => c.key === heatKey)?.label || '1D';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.9rem' }}>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: 0, marginRight: 'auto' }}>
          Major world indices via Yahoo Finance. Returns in each index's local currency
          {view === 'table' ? '; click a column to sort.' : `; heat colors scale within the ${heatLabel} window.`}
        </p>
        {view === 'heatmap' && RET_COLS.map(c => (
          <button key={c.key} onClick={() => setHeatKey(c.key)} style={pill(heatKey === c.key)}>{c.label}</button>
        ))}
        <span style={{ width: '1px', height: '18px', background: 'var(--border)', margin: '0 0.3rem' }} />
        <button onClick={() => setView('table')} style={pill(view === 'table')}>Table</button>
        <button onClick={() => setView('heatmap')} style={pill(view === 'heatmap')}>Heatmap</button>
      </div>

      {view === 'heatmap' ? (
        <Heatmap rows={rows} colKey={heatKey} label={heatLabel} />
      ) : (
        REGIONS.map(region => {
          const regionRows = rows.filter(r => r.region === region);
          if (regionRows.length === 0) return null;
          return <RegionTable key={region} region={region} rows={regionRows} />;
        })
      )}
    </div>
  );
}
