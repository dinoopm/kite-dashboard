import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { LineChart, Line, ResponsiveContainer } from 'recharts';

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
  const [searchQuery, setSearchQuery] = useState('');
  
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
        
        const res = await fetch('/api/quotes', {
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
              '1M': null,
              '3M': null,
              '6M': null,
              '1Y': null,
              '3Y': null,
              '5Y': null,
              sparkline: null,
              aboveSma50: null,
              rsi14: null,
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
        // Use the multi-year endpoint that fetches 5Y data in yearly chunks
        const res = await fetch(`/api/historical-full/${index.token}`);
        const resData = await res.json();
        
        if (resData?.content?.[0]?.text) {
          let parsed = JSON.parse(resData.content[0].text);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const latestPrice = index.price;
            const historyObj = calculateHistoricalReturns(parsed, latestPrice);

            // Compute SMA50
            const sorted = [...parsed].sort((a,b) => new Date(a.date) - new Date(b.date));
            let aboveSma50 = null;
            if (sorted.length >= 50) {
              const last50 = sorted.slice(-50).map(c => c.close);
              const sma50 = last50.reduce((s, v) => s + v, 0) / 50;
              aboveSma50 = latestPrice > sma50;
            }

            // Compute RSI-14 (Wilder's smoothed method)
            let rsi14 = null;
            const closes = sorted.map(c => c.close);
            if (closes.length >= 15) {
              const changes = closes.slice(1).map((v, i) => v - closes[i]);
              let avgGain = changes.slice(0, 14).filter(x => x > 0).reduce((s, v) => s + v, 0) / 14;
              let avgLoss = changes.slice(0, 14).filter(x => x < 0).reduce((s, v) => s + Math.abs(v), 0) / 14;
              for (let i = 14; i < changes.length; i++) {
                const gain = changes[i] > 0 ? changes[i] : 0;
                const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
                avgGain = (avgGain * 13 + gain) / 14;
                avgLoss = (avgLoss * 13 + loss) / 14;
              }
              const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
              rsi14 = parseFloat((100 - 100 / (1 + rs)).toFixed(1));
            }

            // Last 30 candles for sparkline
            const sparkline = sorted.slice(-30).map(c => ({ v: c.close }));
            
            setData(prevData => prevData.map(item => 
              item.id === index.id 
                ? { ...item, ...historyObj, sparkline, aboveSma50, rsi14 }
                : item
            ));
          } else {
             setData(prevData => prevData.map(item => 
              item.id === index.id 
                ? { ...item, '1W': 0, '1M': 0, '3M': 0, '6M': 0, '1Y': 0, '3Y': 0, '5Y': 0, sparkline: null, aboveSma50: null, rsi14: null }
                : item
            ));
          }
        }
      } catch (e) {
        console.error("Failed history for", index.name, e);
      }
      
      // Each historical-full call triggers ~5 MCP requests internally,
      // so wait longer between indices to avoid rate limits
      if (mountedRef.current) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  };

  const calculateHistoricalReturns = (candles, currentPrice) => {
    const series = candles.sort((a,b) => new Date(a.date) - new Date(b.date));
    const now = new Date();
    now.setHours(0,0,0,0);
    
    // Find the closing price on the nearest available trading day to the target date.
    // Uses absolute closest match to minimize error from weekends/holidays.
    const getPriceAtDate = (targetDate) => {
      if (!series || series.length === 0) return 0;
      let bestClose = series[0].close;
      let bestDiff = Math.abs(new Date(series[0].date) - targetDate);
      for (let i = 1; i < series.length; i++) {
        const diff = Math.abs(new Date(series[i].date) - targetDate);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestClose = series[i].close;
        } else if (diff > bestDiff) {
          // Since series is sorted by date, once diff starts increasing we can stop
          break;
        }
      }
      return bestClose;
    };

    const d1W = new Date(now); d1W.setDate(now.getDate() - 7);
    const d1M = new Date(now); d1M.setMonth(now.getMonth() - 1);
    const d3M = new Date(now); d3M.setMonth(now.getMonth() - 3);
    const d6M = new Date(now); d6M.setMonth(now.getMonth() - 6);
    const d1Y = new Date(now); d1Y.setFullYear(now.getFullYear() - 1);
    const d3Y = new Date(now); d3Y.setFullYear(now.getFullYear() - 3);
    const d5Y = new Date(now); d5Y.setFullYear(now.getFullYear() - 5);

    const calcPct = (oldPrice) => {
      if (!oldPrice || oldPrice === 0) return 0;
      return ((currentPrice - oldPrice) / oldPrice) * 100;
    };

    return {
      '1W': calcPct(getPriceAtDate(d1W)),
      '1M': calcPct(getPriceAtDate(d1M)),
      '3M': calcPct(getPriceAtDate(d3M)),
      '6M': calcPct(getPriceAtDate(d6M)),
      '1Y': calcPct(getPriceAtDate(d1Y)),
      '3Y': calcPct(getPriceAtDate(d3Y)),
      '5Y': calcPct(getPriceAtDate(d5Y)),
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

  const filteredData = sortedData.filter(row => 
    row.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

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

  const Sparkline = ({ data, aboveSma50 }) => {
    if (!data || data.length === 0) {
      return <td style={{ padding: '0.5rem 1rem' }}><div className="loader" style={{ width: '16px', height: '16px', margin: '0 auto', borderWidth: '2px' }}></div></td>;
    }
    const color = aboveSma50 === null ? '#888' : aboveSma50 ? '#22c55e' : '#ef4444';
    return (
      <td style={{ padding: '0.5rem 1rem' }}>
        <div style={{ width: '100px', height: '36px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <Line
                type="monotone"
                dataKey="v"
                stroke={color}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
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
      <header className="header" style={{ marginBottom: '1.5rem', borderBottom: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1>Sector Indices</h1>
          <p>Real-time & Historical performance of market sectors</p>
        </div>
        <div>
          <input
            type="text"
            placeholder="Search indices..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              padding: '0.6rem 1rem',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              background: 'var(--bg-dark)',
              color: 'var(--text-primary)',
              width: '250px',
              fontSize: '1rem',
              outline: 'none'
            }}
          />
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
              <th onClick={() => requestSort('1M')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '1rem', color: 'var(--text-secondary)' }}>
                1M {renderSortIndicator('1M')}
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
              <th style={{ borderBottom: '1px solid var(--border)', padding: '1rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
                Trend (vs SMA50)
              </th>
              <th style={{ borderBottom: '1px solid var(--border)', padding: '1rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
                RSI(14)
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredData.length > 0 ? filteredData.map((row, idx) => (
              <tr 
                key={row.id} 
                onClick={() => row.token && navigate(`/instrument/${row.token}?symbol=${row.id.split(':')[1]}`)}
                style={{ cursor: row.token ? 'pointer' : 'default', borderBottom: idx !== filteredData.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none', transition: 'background 0.2s' }}
                onMouseOver={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
              >
                <td style={{ textAlign: 'left', padding: '1rem', fontWeight: 'bold' }}>{row.name}</td>
                <td style={{ padding: '1rem', color: 'var(--text-primary)' }}>₹{row.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                <Cell value={row['1D']} />
                <Cell value={row['1W']} />
                <Cell value={row['1M']} />
                <Cell value={row['3M']} />
                <Cell value={row['6M']} />
                <Cell value={row['1Y']} />
                <Cell value={row['3Y']} />
                <Cell value={row['5Y']} />
                <Sparkline data={row.sparkline} aboveSma50={row.aboveSma50} />
                <td style={{ padding: '0.5rem 1rem', textAlign: 'center' }}>
                  {row.rsi14 === null ? (
                    <div className="loader" style={{ width: '16px', height: '16px', margin: '0 auto', borderWidth: '2px' }}></div>
                  ) : (
                    <span style={{
                      display: 'inline-block',
                      padding: '0.2rem 0.5rem',
                      borderRadius: '6px',
                      fontSize: '0.85rem',
                      fontWeight: '600',
                      background: row.rsi14 >= 70 ? 'rgba(239,68,68,0.15)'
                               : row.rsi14 <= 30 ? 'rgba(34,197,94,0.15)'
                               : 'rgba(255,255,255,0.07)',
                      color: row.rsi14 >= 70 ? '#ef4444'
                           : row.rsi14 <= 30 ? '#22c55e'
                           : 'var(--text-secondary)',
                      border: `1px solid ${row.rsi14 >= 70 ? 'rgba(239,68,68,0.3)' : row.rsi14 <= 30 ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.1)'}`
                    }}>
                      {row.rsi14}
                    </span>
                  )}
                </td>
              </tr>
            )) : (
              <tr>
                <td colSpan="11" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No indices match your search.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export default SectorIndices;
