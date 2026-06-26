import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';

// US market overview powered by Alpaca market data (ETF proxies for the big
// indices + the 11 SPDR sector ETFs). Data-only — no trading account involved.

const fmtPrice = (v) => (v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtPct = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const pctColor = (v) => (v == null ? 'var(--text-secondary)' : v >= 0 ? 'var(--success)' : 'var(--danger)');

function IndexCard({ item }) {
  const q = item.quote || {};
  return (
    <Link
      to={`/us/${item.symbol}`}
      className="glass-panel"
      style={{
        textDecoration: 'none', color: 'inherit', padding: '1rem 1.25rem',
        display: 'flex', flexDirection: 'column', gap: '0.35rem', minWidth: 0,
        transition: 'transform 0.15s, border-color 0.15s',
      }}
      onMouseOver={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
      onMouseOut={(e) => { e.currentTarget.style.transform = ''; e.currentTarget.style.borderColor = ''; }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{item.label}</span>
        <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{item.symbol}</span>
      </div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>{fmtPrice(q.last)}</div>
      <div style={{ color: pctColor(q.changePct), fontWeight: 600, fontSize: '0.9rem' }}>
        {q.change != null ? `${q.change >= 0 ? '+' : ''}${fmtPrice(q.change)}` : '—'} ({fmtPct(q.changePct)})
      </div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{item.proxyFor}</div>
    </Link>
  );
}

function SectorRow({ item }) {
  const q = item.quote || {};
  const pct = q.changePct;
  // Heat bar width scales with magnitude, capped at ±3%.
  const mag = pct == null ? 0 : Math.min(Math.abs(pct) / 3, 1) * 100;
  return (
    <Link
      to={`/us/${item.symbol}`}
      style={{
        display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '1rem', alignItems: 'center',
        padding: '0.65rem 0.9rem', textDecoration: 'none', color: 'inherit',
        borderBottom: '1px solid var(--border)',
      }}
      onMouseOver={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
      onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
    >
      <div style={{ minWidth: 0 }}>
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{item.label}</span>
        <span style={{ marginLeft: '0.5rem', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{item.symbol}</span>
        <div style={{ marginTop: '0.3rem', height: '4px', borderRadius: '2px', background: 'var(--bg-dark)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${mag}%`, background: pctColor(pct), opacity: 0.7 }} />
        </div>
      </div>
      <span style={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{fmtPrice(q.last)}</span>
      <span style={{ color: pctColor(pct), fontWeight: 700, textAlign: 'right', minWidth: '72px', fontVariantNumeric: 'tabular-nums' }}>
        {fmtPct(pct)}
      </span>
    </Link>
  );
}

function NotConfigured() {
  return (
    <div className="glass-panel" style={{ padding: '2rem', maxWidth: '640px', lineHeight: 1.6 }}>
      <h3 style={{ color: 'var(--accent)', marginTop: 0 }}>Alpaca keys not configured</h3>
      <p>US market data is served by Alpaca's free market-data API. To enable it:</p>
      <ol style={{ paddingLeft: '1.2rem' }}>
        <li>Create a free account at <a href="https://alpaca.markets" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>alpaca.markets</a> (a paper account is enough — no funding needed).</li>
        <li>Open <strong>Paper Trading → View / Generate API Keys</strong> and copy the Key ID and Secret.</li>
        <li>Add them to the project <code>.env</code>:
          <pre style={{ background: 'var(--bg-dark)', padding: '0.75rem', borderRadius: '6px', overflowX: 'auto' }}>{`ALPACA_API_KEY=your_key_id
ALPACA_API_SECRET=your_secret`}</pre>
        </li>
        <li>Restart the backend.</li>
      </ol>
    </div>
  );
}

export default function UsMarkets() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/us/overview');
      const json = await res.json();
      if (!res.ok) {
        if (json.configured === false) { setNotConfigured(true); return; }
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setData(json);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000); // refresh once a minute
    return () => clearInterval(id);
  }, [load]);

  if (loading) return <div className="loader" />;
  if (notConfigured) return <div style={{ padding: '1rem 0' }}><h2 style={{ marginBottom: '1rem' }}>US Markets</h2><NotConfigured /></div>;

  const sectorsSorted = [...(data?.sectors || [])].sort((a, b) => (b.quote?.changePct ?? -Infinity) - (a.quote?.changePct ?? -Infinity));

  return (
    <div style={{ padding: '0.5rem 0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>US Markets</h2>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          Alpaca · {data?.feed?.toUpperCase()} feed{data?.feed === 'iex' ? ' (15-min delayed)' : ''}
        </span>
      </div>

      {error && (
        <div className="glass-panel" style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--danger)' }}>
          Failed to load: {error}
        </div>
      )}

      {/* Broad indices */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
        {(data?.indices || []).map(i => <IndexCard key={i.symbol} item={i} />)}
      </div>

      {/* Sector ETFs, ranked best → worst */}
      <h3 style={{ marginBottom: '0.75rem' }}>Sectors (SPDR ETFs)</h3>
      <div className="glass-panel" style={{ padding: '0.25rem 0' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '1rem', padding: '0.5rem 0.9rem', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>
          <span>Sector</span><span>Last</span><span style={{ textAlign: 'right' }}>Day %</span>
        </div>
        {sectorsSorted.map(s => <SectorRow key={s.symbol} item={s} />)}
      </div>
    </div>
  );
}
