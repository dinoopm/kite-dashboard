import { Link, useLocation } from 'react-router-dom';
import { useState, useRef } from 'react';
import InstrumentSearch from './InstrumentSearch';
import Logo from './Logo';
import './Navbar.css';

// Sublinks under the "Market Data" dropdown. Adding more is a one-liner.
const MARKET_DATA_LINKS = [
  { to: '/market-data/stock-picks',         label: '★ Quant Stock Picks',       hint: 'Deterministic factor ranking across all feeds for a chosen period.' },
  { to: '/market-data/fii-dii',             label: 'FII / DII Activities',      hint: 'Daily institutional cash-market flows.' },
  { to: '/market-data/large-deals',         label: 'Large Deals',               hint: 'NSE bulk and block deal disclosures by named entities.' },
  { to: '/market-data/52wk-high-low',       label: '52-Week High / Low',        hint: 'Daily snapshot of stocks at or near their yearly extremes.' },
  { to: '/market-data/top-gainers-losers',  label: 'Top Gainers / Losers',      hint: 'Daily top movers by index segment.' },
  { to: '/market-data/volume-gainers',      label: 'Volume Gainers',            hint: 'Stocks with unusual volume vs 1W/2W averages.' },
  { to: '/market-data/surveillance',        label: 'Surveillance (ASM / GSM)',  hint: 'NSE ASM and GSM surveillance list — handle with extra care.' },
  { to: '/market-data/macro',               label: 'Macro Economics',           hint: 'GDP, inflation, RBI policy, fiscal & external balances.' },
  { to: '/market-data/events',              label: 'Corporate Events',          hint: 'Upcoming results/dividend dates + your own events; holdings highlighted.' },
  { to: '/market-data/expiry',              label: 'F&O Expiry',                hint: 'Next monthly expiry, and whether expiry sessions are measurably more volatile (they are not).' },
  { to: '/market-data/oil',                 label: 'Crude Oil (WTI / Brent)',   hint: 'WTI & Brent spot, day change and ranges (10-min delayed).' },
];

// Sublinks under the "US" dropdown (Alpaca-powered US market data).
const US_LINKS = [
  { to: '/us',          label: 'Indices',  hint: 'US indices & sectors performance, RRG, and drilldown.' },
  { to: '/us/macro',    label: 'Macro',    hint: 'US 10Y Treasury yield + risk-on/off money-flow read.' },
  { to: '/us/screener', label: 'Screener', hint: 'Screen the S&P 500, Nasdaq 100, a sector, or your own basket.' },
  { to: '/us/stock-picks', label: 'Quant Picks', hint: 'Five-factor ranking of S&P 500 + Nasdaq 100 with a recorded track record vs SPY.' },
  { to: '/us/basket',   label: 'Baskets',  hint: 'Build thematic baskets of US stocks with performance + RRG.' },
  { to: '/us/virtual',  label: 'Virtual',  hint: 'Paper portfolios of US stocks — invested, P&L, day change, allocation.' },
];

function Navbar({ onDisconnect }) {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
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
    <nav className="glass-panel app-navbar" aria-label="Main navigation" onKeyDown={e => {
      if (e.key === 'Escape') { setMobileOpen(false); setUsOpen(false); setMarketDataOpen(false); }
    }}>
      <div className="navbar-brand">
        <Link to="/" title="Kite Analytics"><Logo height={40} /></Link>
        <button type="button" className="navbar-toggle" aria-label="Toggle navigation"
          aria-expanded={mobileOpen} aria-controls="primary-navigation" onClick={() => setMobileOpen(!mobileOpen)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d={mobileOpen ? 'M6 6l12 12M6 18L18 6' : 'M4 6h16M4 12h16M4 18h16'} />
          </svg>
        </button>
      </div>
      <div className="navbar-links" id="primary-navigation" data-open={mobileOpen} onClick={e => {
        if (e.target.closest('a')) { setMobileOpen(false); setUsOpen(false); setMarketDataOpen(false); }
      }}>
        <Link to="/" style={linkStyle(location.pathname === '/')}>Dashboard</Link>
        <Link to="/portfolio" style={linkStyle(location.pathname === '/portfolio')}>Portfolio</Link>
        <Link to="/journal" style={linkStyle(location.pathname === '/journal')}>Journal</Link>
        <Link to="/virtual" style={linkStyle(location.pathname.startsWith('/virtual'))}>Virtual</Link>
        <Link to="/basket" style={linkStyle(location.pathname.startsWith('/basket'))}>Basket</Link>
        <Link to="/screener" style={linkStyle(location.pathname === '/screener')}>Screener</Link>
        <Link to="/indices" style={linkStyle(location.pathname === '/indices')}>Indices</Link>
        <Link to="/vix" style={linkStyle(location.pathname === '/vix')}>VIX</Link>
        <Link to="/crypto" style={linkStyle(location.pathname === '/crypto')}>Crypto</Link>
        {/* US dropdown (Indices + Screener) */}
        <div className="navbar-menu navbar-menu-us" onMouseEnter={openUsMenu} onMouseLeave={scheduleUsClose} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setUsOpen(false); }}>
          <button type="button" className="navbar-menu-trigger" aria-expanded={usOpen} aria-controls="us-navigation" onClick={e => setUsOpen(e.detail ? true : !usOpen)} style={linkStyle(onUsPage)}>
            US
            <span style={{ fontSize: '0.7rem', transition: 'transform 0.15s', transform: usOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</span>
          </button>
          {usOpen && (
            <div id="us-navigation" className="navbar-dropdown-panel" onMouseEnter={openUsMenu} onMouseLeave={scheduleUsClose}>
              <div style={{ background: 'var(--bg-card, #0f172a)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.4rem 0', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>
                {US_LINKS.map(l => {
                  const active = l.to === '/us'
                    ? (onUsPage && !['/us/macro', '/us/screener', '/us/stock-picks', '/us/basket', '/us/virtual'].some(p => location.pathname.startsWith(p)))
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
          className="navbar-menu navbar-menu-market"
          onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setMarketDataOpen(false); }}
        >
          <button type="button" className="navbar-menu-trigger" style={linkStyle(onMarketDataPage)}
            aria-expanded={marketDataOpen} aria-controls="market-navigation" onClick={e => setMarketDataOpen(e.detail ? true : !marketDataOpen)}>
            Market Data
            <span style={{ fontSize: '0.7rem', transition: 'transform 0.15s', transform: marketDataOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</span>
          </button>
          {marketDataOpen && (
            // Panel sits FLUSH against the trigger (top: 100%, no marginTop).
            // A transparent paddingTop creates the visual breathing room while
            // keeping the hover area continuous so the cursor never crosses
            // dead space on its way down to the menu items.
            <div
              onMouseEnter={openMenu}
              onMouseLeave={scheduleClose}
              id="market-navigation" className="navbar-dropdown-panel"
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
            fontSize: '0.95rem',
            whiteSpace: 'nowrap',
          }}
        >
          Ask AI
        </Link>

      </div>
      <div className="navbar-search"><InstrumentSearch /></div>
      <div className="navbar-account-actions">
        <button type="button" className="navbar-signout" onClick={onDisconnect}>Sign Out</button>
      </div>
    </nav>
  );
}

export default Navbar;
