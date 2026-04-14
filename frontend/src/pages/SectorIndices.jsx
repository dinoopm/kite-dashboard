import { useState, useEffect, useRef, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Cell as RechartsCell, ResponsiveContainer } from 'recharts';

const INDICES = [
  { key: "NSE:NIFTY 50", name: "NIFTY 50", category: "broad" },
  { key: "NSE:NIFTY NEXT 50", name: "NIFTY NEXT 50", category: "broad" },
  { key: "NSE:NIFTY 100", name: "NIFTY 100", category: "broad" },
  { key: "NSE:NIFTY 200", name: "NIFTY 200", category: "broad" },
  { key: "NSE:NIFTY 500", name: "NIFTY 500", category: "broad" },
  { key: "NSE:NIFTY TOTAL MKT", name: "NIFTY TOTAL MKT", category: "broad" },
  { key: "NSE:NIFTY MIDCAP 150", name: "NIFTY MIDCAP 150", category: "broad" },
  { key: "NSE:NIFTY MIDCAP 100", name: "MIDCAP 100", category: "broad" },
  { key: "NSE:NIFTY MID SELECT", name: "NIFTY MID SELECT", category: "broad" },
  { key: "NSE:NIFTY SMLCAP 250", name: "NIFTY SMLCAP 250", category: "broad" },
  { key: "NSE:NIFTY SMLCAP 100", name: "SMLCAP 100", category: "broad" },
  { key: "BSE:SENSEX", name: "SENSEX", category: "broad" },
  { key: "NSE:NIFTY BANK", name: "NIFTY BANK", category: "sector" },
  { key: "BSE:BANKEX", name: "BANKEX", category: "sector" },
  { key: "NSE:NIFTY IT", name: "NIFTY IT", category: "sector" },
  { key: "NSE:NIFTY AUTO", name: "NIFTY AUTO", category: "sector" },
  { key: "NSE:NIFTY PHARMA", name: "NIFTY PHARMA", category: "sector" },
  { key: "NSE:NIFTY FMCG", name: "NIFTY FMCG", category: "sector" },
  { key: "NSE:NIFTY REALTY", name: "NIFTY REALTY", category: "sector" },
  { key: "NSE:NIFTY PSU BANK", name: "NIFTY PSU BANK", category: "sector" },
  { key: "NSE:NIFTY METAL", name: "NIFTY METAL", category: "sector" },
  { key: "NSE:NIFTY INFRA", name: "NIFTY INFRA", category: "sector" },
  { key: "NSE:NIFTY ENERGY", name: "NIFTY ENERGY", category: "sector" },
  { key: "NSE:NIFTY FIN SERVICE", name: "NIFTY FIN SERVICE", category: "sector" },
];

function SectorIndices() {
  const navigate = useNavigate();
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('sector');
  
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
        const instruments = INDICES.map(i => i.key);
        
        const res = await fetch('/api/quotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instruments }),
        });
        
        const resData = await res.json();
        
        if (resData?.content?.[0]?.text) {
          const quotes = JSON.parse(resData.content[0].text);
          const initialData = INDICES.map(entry => {
            const quote = quotes[entry.key] || {};
            const lastPrice = quote.last_price || 0;
            const changeStr = quote.net_change !== undefined 
              ? quote.net_change 
              : (quote.last_price - (quote.ohlc?.close || quote.last_price));
            
            const pct1D = quote.ohlc?.close ? (changeStr / quote.ohlc.close) * 100 : 0;
            
            return {
              id: entry.key,
              name: entry.name,
              category: entry.category,
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
            const sorted = parsed.sort((a,b) => new Date(a.date) - new Date(b.date));
            const latestPrice = index.price;
            const historyObj = calculateHistoricalReturns(sorted, latestPrice);

            // Compute SMA50
            let aboveSma50 = null;
            if (sorted.length >= 50) {
              const last50 = sorted.slice(-50);
              const sma50 = last50.reduce((s, c) => s + c.close, 0) / 50;
              aboveSma50 = latestPrice > sma50;
            }

            // Compute RSI-14 (Wilder's smoothed method)
            let rsi14 = null;
            if (sorted.length >= 15) {
              const closes = sorted.map(c => c.close);
              const changes = closes.slice(1).map((v, i) => v - closes[i]);
              let avgGain = 0, avgLoss = 0;
              for (let i = 0; i < 14; i++) {
                if (changes[i] > 0) avgGain += changes[i];
                else avgLoss += Math.abs(changes[i]);
              }
              avgGain /= 14;
              avgLoss /= 14;
              for (let i = 14; i < changes.length; i++) {
                avgGain = (avgGain * 13 + (changes[i] > 0 ? changes[i] : 0)) / 14;
                avgLoss = (avgLoss * 13 + (changes[i] < 0 ? Math.abs(changes[i]) : 0)) / 14;
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
      
      // With backend caching, repeat visits are instant.
      // First-time fetches still need rate-limit spacing.
      if (mountedRef.current) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  };

  const calculateHistoricalReturns = (series, currentPrice) => {
    // series is already sorted by date ascending
    // Use IST (UTC+5:30) for date calculations since Indian markets operate in IST
    const nowUTC = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000; // IST = UTC + 5:30
    const nowIST = new Date(nowUTC.getTime() + (nowUTC.getTimezoneOffset() * 60000) + istOffset);
    nowIST.setHours(0,0,0,0);
    
    // Pre-parse dates once for binary search
    const dates = series.map(c => new Date(c.date).getTime());
    
    // Binary search for nearest date
    const getPriceAtDate = (targetDate) => {
      if (dates.length === 0) return 0;
      const target = targetDate.getTime();
      let lo = 0, hi = dates.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (dates[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      // lo is the first date >= target; check if lo-1 is closer
      if (lo > 0 && Math.abs(dates[lo - 1] - target) <= Math.abs(dates[lo] - target)) {
        return series[lo - 1].close;
      }
      return series[lo].close;
    };

    const d1W = new Date(nowIST); d1W.setDate(nowIST.getDate() - 7);
    const d1M = new Date(nowIST); d1M.setMonth(nowIST.getMonth() - 1);
    const d3M = new Date(nowIST); d3M.setMonth(nowIST.getMonth() - 3);
    const d6M = new Date(nowIST); d6M.setMonth(nowIST.getMonth() - 6);
    const d1Y = new Date(nowIST); d1Y.setFullYear(nowIST.getFullYear() - 1);
    const d3Y = new Date(nowIST); d3Y.setFullYear(nowIST.getFullYear() - 3);
    const d5Y = new Date(nowIST); d5Y.setFullYear(nowIST.getFullYear() - 5);

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

  // ─── Momentum Score Calculation ───────────────────────────────
  const W_1W = 0.20, W_1M = 0.50, W_3M = 0.30;

  const calculateMomentumScores = (items) => {
    // Only score items that have all required returns loaded
    const scorable = items.filter(r => r['1W'] !== null && r['1M'] !== null && r['3M'] !== null);
    if (scorable.length === 0) return items;

    // Step 1: Calculate raw weighted return
    const rawScores = scorable.map(r => {
      const raw = ((r['1W'] || 0) * W_1W) + ((r['1M'] || 0) * W_1M) + ((r['3M'] || 0) * W_3M);
      
      // Step 2: RSI adjustment — penalize overbought, boost oversold
      let rsiMultiplier = 1.0;
      if (r.rsi14 !== null) {
        if (r.rsi14 >= 80) rsiMultiplier = 0.85;       // Severely overbought: -15%
        else if (r.rsi14 >= 70) rsiMultiplier = 0.92;   // Overbought: -8%
        else if (r.rsi14 <= 20) rsiMultiplier = 1.15;   // Severely oversold: +15%
        else if (r.rsi14 <= 30) rsiMultiplier = 1.08;   // Oversold: +8%
      }
      
      return { id: r.id, raw, adjusted: raw * rsiMultiplier };
    });

    // Step 3: Percentile ranking (more robust than min-max to outliers)
    const sorted = [...rawScores].sort((a, b) => a.adjusted - b.adjusted);
    const n = sorted.length;
    
    const scoreMap = {};
    const rawMap = {};
    sorted.forEach((s, rank) => {
      // Percentile: rank / (n-1) scaled to 1-100
      scoreMap[s.id] = n === 1 ? 50 : Math.round(1 + (rank / (n - 1)) * 99);
      rawMap[s.id] = s.raw;
    });

    return items.map(r => ({ 
      ...r, 
      momentumScore: scoreMap[r.id] ?? null,
      rawReturn: rawMap[r.id] ?? null
    }));
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

  const tabFiltered = sortedData.filter(row => activeTab === 'all' || row.category === activeTab);
  const withScores = calculateMomentumScores(tabFiltered);
  const filteredData = withScores.filter(row => row.name.toLowerCase().includes(searchQuery.toLowerCase()));

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

  const Sparkline = memo(({ data, aboveSma50 }) => {
    if (!data || data.length === 0) {
      return <td style={{ padding: '0.3rem' }}><div className="loader" style={{ width: '16px', height: '16px', margin: '0 auto', borderWidth: '2px' }}></div></td>;
    }
    const color = aboveSma50 === null ? '#888' : aboveSma50 ? '#22c55e' : '#ef4444';
    return (
      <td style={{ padding: '0.3rem' }}>
        <div style={{ width: '80px', height: '30px' }}>
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
  });

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
          <h1>Indices Performance</h1>
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

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        {[
          { key: 'sector', label: 'Sectors' },
          { key: 'broad', label: 'Broad Market' },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '0.5rem 1.2rem',
              borderRadius: '8px',
              border: activeTab === tab.key ? '1px solid var(--accent)' : '1px solid var(--border)',
              background: activeTab === tab.key ? 'rgba(0, 188, 212, 0.12)' : 'transparent',
              color: activeTab === tab.key ? 'var(--accent)' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontWeight: activeTab === tab.key ? '600' : '400',
              fontSize: '0.9rem',
              transition: 'all 0.2s'
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Momentum Score Bar Chart */}
      {(() => {
        const chartData = filteredData
          .filter(r => r.momentumScore != null)
          .sort((a, b) => b.momentumScore - a.momentumScore)
          .slice(0, 10)
          .map(r => {
            const short = r.name.replace('NIFTY ', '');
            return { 
              name: /^\d+$/.test(short) ? r.name : short, 
              score: r.momentumScore
            };
          });
        
        const getBarColor = (score) => {
          if (score >= 80) return '#10b981';
          if (score >= 60) return '#6ee7b7';
          if (score >= 40) return '#94a3b8';
          if (score >= 20) return '#fca5a5';
          return '#ef4444';
        };

        if (chartData.length === 0) return null;
        return (
          <section className="glass-panel" style={{ padding: '1.5rem', marginBottom: '1rem' }}>
            <h3 style={{ margin: '0 0 0.25rem 0', fontSize: '1.1rem' }}>Kite Momentum Score by {activeTab === 'sector' ? 'Sector' : 'Index'} (1-100)</h3>
            <p style={{ margin: '0 0 1rem 0', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Based on weighted 1W, 1M, and 3M returns</p>
            <div style={{ width: '100%', height: Math.max(200, chartData.length * 40) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 40, left: 10, bottom: 5 }}>
                  <XAxis type="number" domain={[0, 100]} tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
                  <YAxis type="category" dataKey="name" width={120} tick={{ fill: 'var(--text-primary)', fontSize: 12 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload || !payload.length) return null;
                      const d = payload[0];
                      return (
                        <div style={{
                          background: '#1a1a2e',
                          border: '1px solid rgba(255,255,255,0.15)',
                          borderRadius: '8px',
                          padding: '0.6rem 1rem',
                          boxShadow: '0 4px 16px rgba(0,0,0,0.4)'
                        }}>
                          <p style={{ margin: 0, fontWeight: 600, color: '#fff', fontSize: '0.9rem' }}>{d.payload.name}</p>
                          <p style={{ margin: '0.25rem 0 0', color: getBarColor(d.value), fontWeight: 700, fontSize: '1.1rem' }}>
                            Score: {d.value}
                          </p>
                        </div>
                      );
                    }}
                    cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                  />
                  <Bar dataKey="score" radius={[0, 6, 6, 0]} barSize={24} label={{ position: 'right', fill: 'var(--text-secondary)', fontSize: 12, fontWeight: 600 }}>
                    {chartData.map((entry, index) => (
                      <RechartsCell key={`cell-${index}`} fill={getBarColor(entry.score)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
        );
      })()}

      <section className="glass-panel" style={{ padding: '1rem' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'right', fontSize: '0.85rem' }}>
          <thead>
            <tr>
              <th onClick={() => requestSort('name')} style={{ textAlign: 'left', cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>
                Index {renderSortIndicator('name')}
              </th>
              <th onClick={() => requestSort('price')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>
                Price {renderSortIndicator('price')}
              </th>
              <th onClick={() => requestSort('1D')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>
                1D {renderSortIndicator('1D')}
              </th>
              <th onClick={() => requestSort('1W')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>
                1W {renderSortIndicator('1W')}
              </th>
              <th onClick={() => requestSort('1M')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>
                1M {renderSortIndicator('1M')}
              </th>
              <th onClick={() => requestSort('3M')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>
                3M {renderSortIndicator('3M')}
              </th>
              <th onClick={() => requestSort('6M')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>
                6M {renderSortIndicator('6M')}
              </th>
              <th onClick={() => requestSort('1Y')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>
                1Y {renderSortIndicator('1Y')}
              </th>
              <th onClick={() => requestSort('3Y')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>
                3Y {renderSortIndicator('3Y')}
              </th>
              <th onClick={() => requestSort('5Y')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>
                5Y {renderSortIndicator('5Y')}
              </th>
              <th style={{ borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
                Trend
              </th>
              <th style={{ borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
                RSI
              </th>
              <th onClick={() => requestSort('momentumScore')} title="Ranks sectors by recent trend strength (1-100). Higher = stronger momentum. The % below shows the blended return." style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
                Momentum {renderSortIndicator('momentumScore')}
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
                <td style={{ textAlign: 'left', padding: '0.5rem', fontWeight: 'bold' }}>{row.name}</td>
                <td style={{ padding: '0.5rem', color: 'var(--text-primary)' }}>₹{row.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                <Cell value={row['1D']} />
                <Cell value={row['1W']} />
                <Cell value={row['1M']} />
                <Cell value={row['3M']} />
                <Cell value={row['6M']} />
                <Cell value={row['1Y']} />
                <Cell value={row['3Y']} />
                <Cell value={row['5Y']} />
                <Sparkline data={row.sparkline} aboveSma50={row.aboveSma50} />
                <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>
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
                <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>
                  {row.momentumScore == null ? (
                    <div className="loader" style={{ width: '16px', height: '16px', margin: '0 auto', borderWidth: '2px' }}></div>
                  ) : (
                    <>
                    <span style={{
                      display: 'inline-block',
                      padding: '0.2rem 0.6rem',
                      borderRadius: '6px',
                      fontSize: '0.85rem',
                      fontWeight: '700',
                      minWidth: '36px',
                      background: row.momentumScore >= 80 ? 'rgba(16,185,129,0.2)'
                               : row.momentumScore >= 60 ? 'rgba(110,231,183,0.15)'
                               : row.momentumScore >= 40 ? 'rgba(148,163,184,0.15)'
                               : row.momentumScore >= 20 ? 'rgba(252,165,165,0.15)'
                               : 'rgba(239,68,68,0.2)',
                      color: row.momentumScore >= 80 ? '#10b981'
                           : row.momentumScore >= 60 ? '#6ee7b7'
                           : row.momentumScore >= 40 ? '#94a3b8'
                           : row.momentumScore >= 20 ? '#fca5a5'
                           : '#ef4444',
                      border: `1px solid ${row.momentumScore >= 80 ? 'rgba(16,185,129,0.3)' : row.momentumScore >= 60 ? 'rgba(110,231,183,0.3)' : row.momentumScore >= 40 ? 'rgba(148,163,184,0.2)' : row.momentumScore >= 20 ? 'rgba(252,165,165,0.3)' : 'rgba(239,68,68,0.3)'}`
                    }}>
                      {row.momentumScore}
                    </span>
                    </>
                  )}
                </td>
              </tr>
            )) : (
              <tr>
                <td colSpan="14" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No indices match your search.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export default SectorIndices;
