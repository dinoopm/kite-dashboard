import { Link, useLocation } from 'react-router-dom';

function Navbar({ onDisconnect }) {
  const location = useLocation();

  return (
    <nav className="glass-panel" style={{ display: 'flex', gap: '1.5rem', marginBottom: '2rem', padding: '1rem 2rem', alignItems: 'center' }}>
      <h2 style={{ margin: 0, marginRight: '1rem', color: 'var(--accent)' }}>Kite Analytics</h2>
      <Link 
        to="/" 
        style={{ 
          textDecoration: 'none', 
          color: location.pathname === '/' ? 'white' : 'var(--text-secondary)',
          fontWeight: location.pathname === '/' ? 'bold' : 'normal',
          transition: 'color 0.2s'
        }}
      >
        Dashboard
      </Link>
      <Link 
        to="/portfolio" 
        style={{ 
          textDecoration: 'none', 
          color: location.pathname === '/portfolio' ? 'white' : 'var(--text-secondary)',
          fontWeight: location.pathname === '/portfolio' ? 'bold' : 'normal',
          transition: 'color 0.2s'
        }}
      >
        Portfolio
      </Link>
      <Link 
        to="/alerts" 
        style={{ 
          textDecoration: 'none', 
          color: location.pathname === '/alerts' ? 'white' : 'var(--text-secondary)',
          fontWeight: location.pathname === '/alerts' ? 'bold' : 'normal',
          transition: 'color 0.2s'
        }}
      >
        Technical Alerts
      </Link>
      <Link 
        to="/indices" 
        style={{ 
          textDecoration: 'none', 
          color: location.pathname === '/indices' ? 'white' : 'var(--text-secondary)',
          fontWeight: location.pathname === '/indices' ? 'bold' : 'normal',
          transition: 'color 0.2s'
        }}
      >
        Indices Performance
      </Link>
      <Link 
        to="/vix" 
        style={{ 
          textDecoration: 'none', 
          color: location.pathname === '/vix' ? 'white' : 'var(--text-secondary)',
          fontWeight: location.pathname === '/vix' ? 'bold' : 'normal',
          transition: 'color 0.2s'
        }}
      >
        VIX Index
      </Link>

      <div style={{ flex: 1 }}></div>

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
          transition: 'all 0.2s ease'
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
