import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

const INDICES_MAP = {
  "NSE:NIFTY 50": "NIFTY 50",
  "NSE:NIFTY NEXT 50": "NIFTY NEXT 50",
  "NSE:NIFTY 100": "NIFTY 100",
  "NSE:NIFTY 200": "NIFTY 200",
  "NSE:NIFTY MIDCAP 150": "NIFTY MIDCAP 150",
  "NSE:NIFTY SMLCAP 250": "NIFTY SMLCAP 250",
  "NSE:NIFTY BANK": "NIFTY BANK",
  "NSE:NIFTY IT": "NIFTY IT",
  "NSE:NIFTY AUTO": "NIFTY AUTO",
  "NSE:NIFTY PHARMA": "NIFTY PHARMA",
  "NSE:NIFTY FMCG": "NIFTY FMCG",
  "NSE:NIFTY REALTY": "NIFTY REALTY",
  "BSE:SENSEX": "SENSEX",
  "BSE:BANKEX": "BANKEX",
  "NSE:NIFTY 500": "NIFTY 500",
  "NSE:NIFTY MNC": "NIFTY MNC",
  "NSE:NIFTY PSU BANK": "NIFTY PSU BANK",
  "NSE:NIFTY METAL": "NIFTY METAL",
  "NSE:NIFTY INFRA": "NIFTY INFRA",
  "NSE:NIFTY ENERGY": "NIFTY ENERGY",
  "NSE:NIFTY FIN SERVICE": "NIFTY FIN SERVICE",
  "NSE:NIFTY TOTAL MKT": "NIFTY TOTAL MKT",
  "NSE:NIFTY MID SELECT": "NIFTY MID SELECT",
  "NSE:NIFTY MIDCAP 100": "MIDCAP",
  "NSE:NIFTY SMLCAP 100": "SMLCAP"
};

function SectorIndices() {
  const navigate = useNavigate();
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  // Sorting state
  const [sortConfig, setSortConfig] = useState({ key: 'name', direction: 'asc' });

  // Progressive loading queue refs
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const fetchQuotes = async () => {
      try {
        setLoading(true);
        const instruments = Object.keys(INDICES_MAP);
        
        const res = await fetch('http://localhost:3001/api/quotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instruments }),
        });
        
        const resData = await res.json();
        
        if (resData?.content?.[0]?.text) {
          const quotes = JSON.parse(resData.content[0].text);
          const initialData = instruments.map(inst => {
            const quote = quotes[inst] || {};
            const lastPrice = quote.last_price || 0;
            const changeStr = quote.net_change !== undefined 
              ? quote.net_change 
              : (quote.last_price - (quote.ohlc?.close || quote.last_price));
            
            const pct1D = quote.ohlc?.close ? (changeStr / quote.ohlc.close) * 100 : 0;
            
            return {
              id: inst,
              name: INDICES_MAP[inst],
              token: quote.instrument_token,
              price: lastPrice,
              '1D': pct1D,
              '1W': null,
              '3M': null,
              '6M': null,
              '1Y': null,
              '3Y': null,
              '5Y': null,
            };
          });
          
          if (mountedRef.current) {
            setData(initialData);
            setLoading(false);
            // Kick off progressive history loading
            loadHistoricalDataProgressively(initialData.filter(d => d.token));
          }
        } else {
          throw new Error('Failed to parse quotes');
        }
      } catch (err) {
        if (mountedRef.current) {
          console.error(err);
          setError("Failed to load initial benchmark data. Backend might be down.");
          setLoading(false);
        }
      }
    };
    
    fetchQuotes();
  }, []);

  const loadHistoricalDataProgressively = async (indicesList) => {
    for (let index of indicesList) {
      if (!mountedRef.current) break;
      
      try {
        const res = await fetch(`http://localhost:3001/api/historical/${index.token}?tf=5Y`);
        const resData = await res.json();
        
        if (resData?.content?.[0]?.text) {
          let parsed = JSON.parse(resData.content[0].text);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const latestPrice = index.price; // Approximate against live price
            const historyObj = calculateHistoricalReturns(parsed, latestPrice);
            
            setData(prevData => prevData.map(item => 
              item.id === index.id 
                ? { ...item, ...historyObj }
                : item
            ));
          } else {
             // If data format failed or empty, set to - or 0
             setData(prevData => prevData.map(item => 
              item.id === index.id 
                ? { ...item, '1W': 0, '3M': 0, '6M': 0, '1Y': 0, '3Y': 0, '5Y': 0 }
                : item
            ));
          }
        }
      } catch (e) {
        console.error("Failed history for", index.name, e);
      }
      
      // Sleep for 1.2s to strictly avoid Kite's 3 req/sec limit
      if (mountedRef.current) {
        await new Promise(r => setTimeout(r, 1200));
      }
    }
  };

  const calculateHistoricalReturns = (candles, currentPrice) => {
    // candles are sorted oldest -> newest usually, check dates:
    const series = candles.sort((a,b) => new Date(a.date) - new Date(b.date));
    const now = new Date();
    
    const getPriceAgo = (days) => {
      const targetDate = new Date();
      targetDate.setDate(now.getDate() - days);
      
      // Find the closest candle before or on the target date
      // Start from end to find the most recent one satisfying condition
      let closestClose = series[0].close; // fallback to oldest available
      for (let i = series.length - 1; i >= 0; i--) {
        const cDate = new Date(series[i].date);
        if (cDate <= targetDate) {
          closestClose = series[i].close;
          break;
        }
      }
      return closestClose;
    };

    const c1W = getPriceAgo(7);
    const c3M = getPriceAgo(90);
    const c6M = getPriceAgo(180);
    const c1Y = getPriceAgo(365);
    const c3Y = getPriceAgo(365 * 3);
    const c5Y = getPriceAgo(365 * 5);

    const calcPct = (oldPrice) => {
      if (!oldPrice || oldPrice === 0) return 0;
      return ((currentPrice - oldPrice) / oldPrice) * 100;
    };

    return {
      '1W': calcPct(c1W),
      '3M': calcPct(c3M),
      '6M': calcPct(c6M),
      '1Y': calcPct(c1Y),
      '3Y': calcPct(c3Y),
      '5Y': calcPct(c5Y),
    };
  };

  const requestSort = (key) => {
    let direction = 'desc';
    if (sortConfig.key === key && sortConfig.direction === 'desc') {
      direction = 'asc';
    }
    setSortConfig({ key, direction });
  };

  const sortedData = [...data].sort((a, b) => {
    let valA = a[sortConfig.key];
    let valB = b[sortConfig.key];
    
    // Treat nulls as worst/best depending on sort so they cluster
    if (valA === null) valA = sortConfig.direction === 'asc' ? Infinity : -Infinity;
    if (valB === null) valB = sortConfig.direction === 'asc' ? Infinity : -Infinity;

    if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
    if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
    return 0;
  });

  const renderSortIndicator = (key) => {
    if (sortConfig.key === key) {
      return sortConfig.direction === 'asc' ? ' ↑' : ' ↓';
    }
    return '';
  };

  const Cell = ({ value }) => {
    if (value === null) return <td><div className="loader" style={{ width: '16px', height: '16px', margin: '0 auto', borderWidth: '2px' }}></div></td>;
    if (value === 0) return <td style={{ color: 'var(--text-secondary)' }}>0.00%</td>;
    return (
      <td className={value > 0 ? 'positive' : 'negative'} style={{ fontWeight: '500' }}>
        {value > 0 ? '+' : ''}{value.toFixed(2)}%
      </td>
    );
  };

  if (loading) return <div className="loader"></div>;

  if (error) {
    return (
      <div className="dashboard-layout">
        <div className="glass-panel">
          <p className="negative">{error}</p>
          <button onClick={() => window.location.reload()} style={{ padding: '0.5rem 1rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', marginTop: '1rem' }}>Reload</button>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-layout">
      <header className="header" style={{ marginBottom: '1.5rem', borderBottom: 'none' }}>
        <div>
          <h1>Sector Indices</h1>
          <p>Real-time & Historical performance of market sectors</p>
        </div>
      </header>

      <section className="glass-panel" style={{ padding: '1rem', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'right' }}>
          <thead>
            <tr>
              <th onClick={() => requestSort('name')} style={{ textAlign: 'left', cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '1rem', color: 'var(--text-secondary)' }}>
                Index Name {renderSortIndicator('name')}
              </th>
              <th onClick={() => requestSort('price')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '1rem', color: 'var(--text-secondary)' }}>
                Price {renderSortIndicator('price')}
              </th>
              <th onClick={() => requestSort('1D')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '1rem', color: 'var(--text-secondary)' }}>
                1D {renderSortIndicator('1D')}
              </th>
              <th onClick={() => requestSort('1W')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '1rem', color: 'var(--text-secondary)' }}>
                1W {renderSortIndicator('1W')}
              </th>
              <th onClick={() => requestSort('3M')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '1rem', color: 'var(--text-secondary)' }}>
                3M {renderSortIndicator('3M')}
              </th>
              <th onClick={() => requestSort('6M')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '1rem', color: 'var(--text-secondary)' }}>
                6M {renderSortIndicator('6M')}
              </th>
              <th onClick={() => requestSort('1Y')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '1rem', color: 'var(--text-secondary)' }}>
                1Y {renderSortIndicator('1Y')}
              </th>
              <th onClick={() => requestSort('3Y')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '1rem', color: 'var(--text-secondary)' }}>
                3Y {renderSortIndicator('3Y')}
              </th>
              <th onClick={() => requestSort('5Y')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '1rem', color: 'var(--text-secondary)' }}>
                5Y {renderSortIndicator('5Y')}
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedData.map((row, idx) => (
              <tr 
                key={row.id} 
                onClick={() => row.token && navigate(`/instrument/${row.token}?symbol=${row.id.split(':')[1]}`)}
                style={{ cursor: row.token ? 'pointer' : 'default', borderBottom: idx !== sortedData.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none', transition: 'background 0.2s' }}
                onMouseOver={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
              >
                <td style={{ textAlign: 'left', padding: '1rem', fontWeight: 'bold' }}>{row.name}</td>
                <td style={{ padding: '1rem', color: 'var(--text-primary)' }}>₹{row.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                <Cell value={row['1D']} />
                <Cell value={row['1W']} />
                <Cell value={row['3M']} />
                <Cell value={row['6M']} />
                <Cell value={row['1Y']} />
                <Cell value={row['3Y']} />
                <Cell value={row['5Y']} />
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export default SectorIndices;
