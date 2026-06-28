import { Link, useLocation } from 'react-router-dom';
import { useState, useRef } from 'react';
import InstrumentSearch from './InstrumentSearch';
import Logo from './Logo';

// Sublinks under the "Market Data" dropdown. Adding more is a one-liner.
const MARKET_DATA_LINKS = [
  { to: '/market-data/fii-dii',             label: 'FII / DII Activities',      hint: 'Daily institutional cash-market flows.' },
  { to: '/market-data/large-deals',         label: 'Large Deals',               hint: 'NSE bulk and block deal disclosures by named entities.' },
  { to: '/market-data/52wk-high-low',       label: '52-Week High / Low',        hint: 'Daily snapshot of stocks at or near their yearly extremes.' },
  { to: '/market-data/top-gainers-losers',  label: 'Top Gainers / Losers',      hint: 'Daily top movers by index segment.' },
  { to: '/market-data/volume-gainers',      label: 'Volume Gainers',            hint: 'Stocks with unusual volume vs 1W/2W averages.' },
  { to: '/market-data/surveillance',        label: 'Surveillance (ASM / GSM)',  hint: 'NSE ASM and GSM surveillance list — handle with extra care.' },
  { to: '/market-data/macro',               label: 'Macro Economics',           hint: 'GDP, inflation, RBI policy, fiscal & external balances.' },
];

// Sublinks under the "US" dropdown (Alpaca-powered US market data).
const US_LINKS = [
  { to: '/us',          label: 'Indices',  hint: 'US indices & sectors performance, RRG, and drilldown.' },
  { to: '/us/screener', label: 'Screener', hint: 'Screen the S&P 500, Nasdaq 100, a sector, or your own basket.' },
  { to: '/us/basket',   label: 'Baskets',  hint: 'Build thematic baskets of US stocks with performance + RRG.' },
  { to: '/us/virtual',  label: 'Virtual',  hint: 'Paper portfolios of US stocks — invested, P&L, day change, allocation.' },
];

function Navbar({ onDisconnect }) {
  const location = useLocation();
  const [marketDataOpen, setMarketDataOpen] = useState(false);
  // Small close delay so brief cursor wobbles between trigger and panel
  // don't immediately dismiss the menu. Cleared on re-entry.
  const closeTimerRef = useRef(null);
  const openMenu = () => {
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
    setMarketDataOpen(true);
  };
  const scheduleClose = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => setMarketDataOpen(false), 180);
  };

  // US dropdown — its own state/timer so it opens independently of Market Data.
  const [usOpen, setUsOpen] = useState(false);
  const usCloseTimerRef = useRef(null);
  const openUsMenu = () => {
    if (usCloseTimerRef.current) { clearTimeout(usCloseTimerRef.current); usCloseTimerRef.current = null; }
    setUsOpen(true);
  };
  const scheduleUsClose = () => {
    if (usCloseTimerRef.current) clearTimeout(usCloseTimerRef.current);
    usCloseTimerRef.current = setTimeout(() => setUsOpen(false), 180);
  };

  // Highlight the parent trigger when the user is on any child page.
  const onMarketDataPage = location.pathname.startsWith('/market-data');
  const onUsPage = location.pathname.startsWith('/us');

  const linkStyle = (active) => ({
    textDecoration: 'none',
    color: active ? 'white' : 'var(--text-secondary)',
    fontWeight: active ? 'bold' : 'normal',
    transition: 'color 0.2s',
    whiteSpace: 'nowrap',
  });

  return (
    <nav className="glass-panel" style={{ display: 'flex', gap: '1.5rem', marginBottom: '2rem', padding: '1rem 2rem', alignItems: 'center', position: 'relative', zIndex: 9999 }}>
      <Link to="/" style={{ marginRight: '1rem', textDecoration: 'none' }} title="Kite Analytics">
        <Logo height={52} />
      </Link>
      <Link to="/" style={linkStyle(location.pathname === '/')}>Dashboard</Link>
      <Link to="/portfolio" style={linkStyle(location.pathname === '/portfolio')}>Portfolio</Link>
      <Link to="/virtual" style={linkStyle(location.pathname.startsWith('/virtual'))}>Virtual</Link>
      <Link to="/basket" style={linkStyle(location.pathname.startsWith('/basket'))}>Basket</Link>
      <Link to="/screener" style={linkStyle(location.pathname === '/screener')}>Screener</Link>
      <Link to="/indices" style={linkStyle(location.pathname === '/indices')}>Indices</Link>
      <Link to="/vix" style={linkStyle(location.pathname === '/vix')}>VIX</Link>
      {/* US dropdown (Indices + Screener) */}
      <div onMouseEnter={openUsMenu} onMouseLeave={scheduleUsClose} style={{ position: 'relative' }}>
        <span style={{ ...linkStyle(onUsPage), cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
          US
          <span style={{ fontSize: '0.7rem', transition: 'transform 0.15s', transform: usOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</span>
        </span>
        {usOpen && (
          <div onMouseEnter={openUsMenu} onMouseLeave={scheduleUsClose} style={{ position: 'absolute', top: '100%', left: 0, paddingTop: '0.5rem', minWidth: '220px', zIndex: 10000 }}>
            <div style={{ background: 'var(--bg-card, #0f172a)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.4rem 0', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>
              {US_LINKS.map(l => {
                const active = l.to === '/us'
                  ? (onUsPage && !['/us/screener', '/us/basket', '/us/virtual'].some(p => location.pathname.startsWith(p)))
                  : location.pathname.startsWith(l.to);
                return (
                  <Link
                    key={l.to}
                    to={l.to}
                    title={l.hint}
                    onClick={() => setUsOpen(false)}
                    style={{
                      display: 'block', padding: '0.55rem 0.9rem', textDecoration: 'none',
                      color: active ? 'white' : 'var(--text-secondary)',
                      background: active ? 'rgba(56,189,248,0.10)' : 'transparent',
                      fontSize: '0.85rem', fontWeight: active ? 600 : 500,
                    }}
                    onMouseOver={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                    onMouseOut={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                  >
                    {l.label}
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Market Data dropdown. The outer wrapper keeps cursor-tracking
          continuous across the trigger and the panel — no inter-element gap. */}
      <div
        onMouseEnter={openMenu}
        onMouseLeave={scheduleClose}
        style={{ position: 'relative' }}
      >
        <span
          style={{
            ...linkStyle(onMarketDataPage),
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.25rem',
          }}
        >
          Market Data
          <span style={{ fontSize: '0.7rem', transition: 'transform 0.15s', transform: marketDataOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</span>
        </span>
        {marketDataOpen && (
          // Panel sits FLUSH against the trigger (top: 100%, no marginTop).
          // A transparent paddingTop creates the visual breathing room while
          // keeping the hover area continuous so the cursor never crosses
          // dead space on its way down to the menu items.
          <div
            onMouseEnter={openMenu}
            onMouseLeave={scheduleClose}
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              paddingTop: '0.5rem',
              minWidth: '260px',
              zIndex: 10000,
            }}
          >
            <div
              style={{
                background: 'var(--bg-card, #0f172a)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                padding: '0.4rem 0',
                boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
              }}
            >
              {MARKET_DATA_LINKS.map(l => {
                const active = location.pathname === l.to;
                return (
                  <Link
                    key={l.to}
                    to={l.to}
                    title={l.hint}
                    onClick={() => setMarketDataOpen(false)}
                    style={{
                      display: 'block',
                      padding: '0.55rem 0.9rem',
                      textDecoration: 'none',
                      color: active ? 'white' : 'var(--text-secondary)',
                      background: active ? 'rgba(56,189,248,0.10)' : 'transparent',
                      fontSize: '0.85rem',
                      fontWeight: active ? 600 : 500,
                    }}
                    onMouseOver={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                    onMouseOut={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                  >
                    {l.label}
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </div>

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
        Sign Out
      </button>
    </nav>
  );
}

export default Navbar;
