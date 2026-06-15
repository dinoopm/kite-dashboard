import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { fetchWithAbort } from '../hooks/useFetchWithAbort';

// Compact macro-economy card for the dashboard: repo rate + stance, latest
// CPI, GDP growth. Fetches its own slice of /api/macro-overview (the server's
// 12h cache absorbs the extra hit); clicking through opens the full macro page.
function MacroWidget() {
  const [macro, setMacro] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort('/api/macro-overview', { signal: controller.signal });
        const data = await res.json();
        if (data?.error) throw new Error(data.error);
        setMacro({
          repoRate: data?.policy?.repoRate ?? null,
          stance: data?.policy?.stance ?? null,
          cpi: data?.policy?.cpiLatest ?? data?.summary?.cpiInflation ?? null,
          gdp: data?.summary?.realGDPGrowth ?? null,
          band: data?.inflation?.targetBand ?? { lower: 2, upper: 6 },
        });
      } catch (err) {
        if (err.name === 'AbortError') return;
        setError(err.message);
      }
    })();
    return () => controller.abort();
  }, []);

  const fmt = (v, d = 2) => (v == null ? '—' : `${Number(v).toFixed(d)}%`);
  const cpiInBand = macro?.cpi != null && macro.cpi >= macro.band.lower && macro.cpi <= macro.band.upper;

  const row = (label, value, valueClass, chip) => (
    <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: '8px', padding: '0.6rem 0.9rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {chip && (
          <span style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--accent)', background: 'rgba(56,189,248,0.12)', padding: '0.1rem 0.5rem', borderRadius: '999px' }}>
            {chip}
          </span>
        )}
        <span className={valueClass || ''} style={{ fontWeight: 700, fontSize: '0.95rem' }}>{value}</span>
      </span>
    </div>
  );

  return (
    <Link
      to="/market-data/macro"
      className="glass-panel"
      style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', padding: '1.5rem', textDecoration: 'none', color: 'inherit' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
        <h3 style={{ margin: 0, fontSize: '1.2rem' }}>Macro Economy</h3>
        <span style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa', padding: '0.3rem 0.8rem', borderRadius: '20px', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.05em' }}>
          RBI · GDP · CPI
        </span>
      </div>

      {error ? (
        <p style={{ fontStyle: 'italic', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>No data available</p>
      ) : !macro ? (
        <div className="loader" style={{ margin: '1.5rem 0' }}></div>
      ) : (
        <>
          {row('Repo Rate', fmt(macro.repoRate), '', macro.stance)}
          {row('CPI (latest)', fmt(macro.cpi), macro.cpi == null ? '' : cpiInBand ? 'positive' : 'negative')}
          {row('GDP Growth', fmt(macro.gdp, 1), macro.gdp == null ? '' : macro.gdp > 0 ? 'positive' : 'negative')}
          <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', textAlign: 'right' }}>View full macro overview →</span>
        </>
      )}
    </Link>
  );
}

export default MacroWidget;
