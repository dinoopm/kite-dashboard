import { Link, useLocation } from 'react-router-dom';
import InstrumentSearch from './InstrumentSearch';

// Top-level market-data links — flattened out of the previous dropdown.
// Short labels keep the navbar from overflowing on narrower screens.
const MARKET_DATA_LINKS = [
  { to: '/market-data/fii-dii',            label: 'FII / DII',       hint: 'Daily institutional cash-market flows.' },
  { to: '/market-data/large-deals',        label: 'Large Deals',     hint: 'NSE bulk and block deal disclosures.' },
  { to: '/market-data/52wk-high-low',      label: '52W H/L',         hint: 'Daily snapshot of stocks at their yearly extremes.' },
  { to: '/market-data/top-gainers-losers', label: 'Top Movers',      hint: 'Daily top gainers and losers by index segment.' },
  { to: '/market-data/volume-gainers',     label: 'Volume Gainers',  hint: 'Stocks with unusual volume vs 1W/2W averages.' },
  { to: '/market-data/surveillance',       label: 'Surveillance',    hint: 'NSE ASM/GSM surveillance list.' },
];

function Navbar({ onDisconnect }) {
  const location = useLocation();

  const linkStyle = (active) => ({
    textDecoration: 'none',
    color: active ? 'white' : 'var(--text-secondary)',
    fontWeight: active ? 'bold' : 'normal',
    transition: 'color 0.2s',
    whiteSpace: 'nowrap',
  });

  return (
    <nav className="glass-panel" style={{ display: 'flex', gap: '1.1rem', marginBottom: '2rem', padding: '1rem 1.5rem', alignItems: 'center', position: 'relative', zIndex: 9999, flexWrap: 'wrap' }}>
      <h2 style={{ margin: 0, marginRight: '0.8rem', color: 'var(--accent)', whiteSpace: 'nowrap' }}>Kite Analytics</h2>

      <Link to="/" style={linkStyle(location.pathname === '/')}>Dashboard</Link>
      <Link to="/portfolio" style={linkStyle(location.pathname === '/portfolio')}>Portfolio</Link>
      <Link to="/indices" style={linkStyle(location.pathname === '/indices')}>Indices</Link>
      <Link to="/vix" style={linkStyle(location.pathname === '/vix')}>VIX</Link>

      {MARKET_DATA_LINKS.map(l => (
        <Link
          key={l.to}
          to={l.to}
          title={l.hint}
          style={linkStyle(location.pathname === l.to)}
        >
          {l.label}
        </Link>
      ))}

      <Link
        to="/chat"
        style={{
          textDecoration: 'none',
          color: location.pathname === '/chat' ? 'white' : 'var(--accent)',
          fontWeight: location.pathname === '/chat' ? 'bold' : '600',
          transition: 'color 0.2s',
          background: location.pathname === '/chat' ? 'rgba(56, 189, 248, 0.2)' : 'rgba(56, 189, 248, 0.08)',
          border: '1px solid rgba(56, 189, 248, 0.2)',
          borderRadius: '8px',
          padding: '0.3rem 0.8rem',
          fontSize: '0.85rem',
          whiteSpace: 'nowrap',
        }}
      >
        Ask AI
      </Link>

      <div style={{ flex: 1 }}></div>

      <InstrumentSearch />

      <button
        onClick={onDisconnect}
        style={{
          background: 'rgba(239, 68, 68, 0.1)',
          color: '#ef4444',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          padding: '0.6rem 1.2rem',
          borderRadius: '10px',
          cursor: 'pointer',
          fontWeight: '600',
          transition: 'all 0.2s ease',
          whiteSpace: 'nowrap',
        }}
        onMouseOver={(e) => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)'}
        onMouseOut={(e) => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'}
      >
        Disconnect
      </button>
    </nav>
  );
}

export default Navbar;
