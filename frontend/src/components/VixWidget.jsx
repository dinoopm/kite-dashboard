import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { fetchWithAbort } from '../hooks/useFetchWithAbort';
import { VixGauge } from './VixGauge';

// Compact India-VIX "fear gauge" card for the dashboard. Fetches its own quote
// so it can be dropped in standalone; clicking through opens the full VIX page.
function VixWidget() {
  const [vixQuote, setVixQuote] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort('/api/quotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instruments: ['NSE:INDIA VIX'] }),
          signal: controller.signal,
        });
        const data = await res.json();
        if (data?.content?.[0]?.text) {
          const q = JSON.parse(data.content[0].text);
          setVixQuote(q['NSE:INDIA VIX'] || null);
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        setError(err.message);
      }
    })();
    return () => controller.abort();
  }, []);

  const vixValue = vixQuote?.last_price || 0;
  const vixChange = vixQuote?.ohlc?.close ? ((vixValue - vixQuote.ohlc.close) / vixQuote.ohlc.close) * 100 : 0;
  const changeColor = vixChange >= 0 ? '#10b981' : '#ef4444';
  const changeBg = vixChange >= 0 ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';

  return (
    <Link
      to="/vix"
      className="glass-panel"
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: '0.5rem', padding: '1.5rem', textDecoration: 'none', color: 'inherit',
      }}
    >
      <div style={{ alignSelf: 'stretch', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
        <h3 style={{ margin: 0, fontSize: '1.2rem' }}>India VIX</h3>
        <span style={{ background: 'rgba(110,231,183,0.1)', color: '#6ee7b7', padding: '0.3rem 0.8rem', borderRadius: '20px', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.05em' }}>FEAR GAUGE</span>
      </div>

      {error ? (
        <p className="negative" style={{ fontSize: '0.85rem' }}>{error}</p>
      ) : !vixQuote ? (
        <div className="loader" style={{ margin: '2rem 0' }}></div>
      ) : (
        <>
          <VixGauge value={vixValue} />
          <div style={{ marginTop: '0.75rem', display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <span style={{ fontWeight: 700, fontSize: '1.5rem' }}>{vixValue.toFixed(2)}</span>
            <span style={{ fontSize: '0.8rem', fontWeight: 700, color: changeColor, background: changeBg, padding: '0.15rem 0.5rem', borderRadius: '4px' }}>
              {vixChange >= 0 ? '+' : ''}{vixChange.toFixed(2)}%
            </span>
          </div>
        </>
      )}
    </Link>
  );
}

export default VixWidget;
