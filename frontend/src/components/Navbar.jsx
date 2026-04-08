import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';

function Navbar() {
  const location = useLocation();
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Check auth status on route change
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch('http://localhost:3001/api/profile');
        const data = await res.json();
        // If profile exists and it's not an error, we are authenticated
        setIsAuthenticated(!!(data && !data.isError && !data.error));
      } catch (err) {
        setIsAuthenticated(false);
      }
    };
    checkAuth();
  }, [location.pathname]);

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

      <div style={{ flex: 1 }}></div>

      {isAuthenticated && (
        <button
          onClick={async () => {
            if (window.confirm('Disconnect the kite dashboard? You will need to login again.')) {
              try {
                // 1. Fire the disconnect to reset backend MCP
                await fetch('http://localhost:3001/api/disconnect', { method: 'POST' });
                
                // 2. Redirect locally to homepage as requested
                // This ensures we're on the root while the session is destroyed
                window.location.href = '/'; 
              } catch (err) {
                console.error('Failed to disconnect', err);
              }
            }
          }}
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
      )}
    </nav>
  );
}

export default Navbar;
