import { useState, useEffect } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { format, parseISO } from 'date-fns'
import { fetchWithAbort } from '../hooks/useFetchWithAbort'

function Instrument() {
  const { token } = useParams()
  const [searchParams] = useSearchParams()
  const symbol = searchParams.get('symbol')
  const navigate = useNavigate()

  const [data, setData] = useState([])
  const [quote, setQuote] = useState(null)
  const [indicators, setIndicators] = useState(null)
  const [fundamentals, setFundamentals] = useState(null)
  const [cashflow, setCashflow] = useState(null)
  // Company name sourced from Kite (search_instruments) — populates faster than
  // Yahoo fundamentals and is canonical for Indian tickers.
  const [kiteName, setKiteName] = useState(null)
  // Quarterly Results scraped from screener.in (richer + denser than Yahoo for
  // Indian tickers — no gaps, 13 quarters of history typically).
  const [screenerQuarterly, setScreenerQuarterly] = useState(null)
  const [screenerError, setScreenerError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [timeframe, setTimeframe] = useState('1M')
  const [activeTab, setActiveTab] = useState('technicals')
  const [cashflowType, setCashflowType] = useState('quarterly')

  // Fetch live quote
  useEffect(() => {
    if (!symbol) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort('/api/quotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instruments: [`NSE:${symbol}`] }),
          signal: controller.signal
        });
        const resData = await res.json();
        if (resData?.content?.[0]?.text) {
          const parsed = JSON.parse(resData.content[0].text);
          const key = `NSE:${symbol}`;
          if (parsed[key]) setQuote(parsed[key]);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    })();
    return () => controller.abort();
  }, [symbol])

  // Fetch canonical company name from Kite (search_instruments)
  useEffect(() => {
    if (!symbol) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort(`/api/instrument-info/${symbol}`, { signal: controller.signal });
        const info = await res.json();
        if (info?.name) setKiteName(info.name);
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    })();
    return () => controller.abort();
  }, [symbol])

  // Fetch quarterly results from screener.in scrape (cached 12h server-side)
  useEffect(() => {
    if (!symbol) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort(`/api/screener-quarterly/${symbol}`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.quarters) && data.quarters.length > 0) {
            setScreenerQuarterly(data);
          } else {
            setScreenerError('Screener returned no quarterly rows');
          }
        } else {
          const err = await res.json().catch(() => ({}));
          setScreenerError(err.error || `Screener fetch failed (${res.status})`);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        setScreenerError(e.message);
      }
    })();
    return () => controller.abort();
  }, [symbol])

  // Fetch indicators
  useEffect(() => {
    const controller = new AbortController();
    let retries = 0;
    const maxRetries = 2;
    let retryTimer = null;
    const fetchIndicators = async () => {
      try {
        const res = await fetchWithAbort(`/api/indicators/${token}`, { signal: controller.signal })
        if (res.ok) {
          const data = await res.json()
          setIndicators(data)
        } else if (res.status === 404 && retries < maxRetries) {
          // If backend is still warming the cache, try again once more in 3 seconds
          retries++;
          retryTimer = setTimeout(fetchIndicators, 3000);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        if (retries < maxRetries) {
          retries++;
          retryTimer = setTimeout(fetchIndicators, 3000);
        }
      }
    }
    fetchIndicators()
    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [token])

  // Fetch fundamentals
  useEffect(() => {
    if (!symbol) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort(`/api/fundamentals/${symbol}`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          setFundamentals(data);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        console.error("Failed to fetch fundamentals", e);
      }
    })();
    return () => controller.abort();
  }, [symbol]);

  useEffect(() => {
    if (!symbol) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort(`/api/cashflow/${symbol}?type=${cashflowType}`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          setCashflow(data);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        console.error("Failed to fetch cashflow", e);
      }
    })();
    return () => controller.abort();
  }, [symbol, cashflowType]);

  // Fetch historical data
  useEffect(() => {
    const controller = new AbortController();
    const fetchHistoricalData = async () => {
      try {
        setLoading(true)
        setError(null)
        const res = await fetchWithAbort(`/api/historical/${token}?tf=${timeframe}&t=${Date.now()}`, { signal: controller.signal })
        const resData = await res.json()

        if (resData.isError || resData.error) {
          let msg = resData.content?.[0]?.text || resData.error || "Unknown error";
          if (msg.includes("Failed to get historical data")) {
            msg = "Market data for the selected timeframe is unavailable or restricted by Kite.";
          }
          setError(msg)
          return
        }

        if (resData?.content?.[0]?.text) {
          let parsed = JSON.parse(resData.content[0].text);

          if (Array.isArray(parsed)) {
            let fullChartData = parsed.map(c => {
              // Extract "2026-03-30" from "2026-03-30T00:00:00+05:30"
              const ymd = c.date.substring(0, 10);
              const [yyyy, mm, dd] = ymd.split('-');
              const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
              const safeDate = `${months[parseInt(mm, 10) - 1]} ${parseInt(dd, 10)}, ${yyyy}`;

              return {
                dateObj: new Date(c.date),
                date: timeframe === '1D'
                  ? c.date.substring(11, 16) // Extracts "09:15" directly from "2026-04-07T09:15:00+05:30"
                  : safeDate,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                sma20: c.sma20,
                sma5: c.sma5
              };
            })

            if (timeframe === '1D' && fullChartData.length > 0) {
              const lastDateStr = fullChartData[fullChartData.length - 1].dateObj.toDateString();
              const todayData = fullChartData.filter(c => c.dateObj.toDateString() === lastDateStr);
              setData(todayData)
            } else {
              setData(fullChartData)
            }
          } else {
            setError('Unexpected historical data format.')
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        setError('Error connecting to backend API.')
      } finally {
        setLoading(false)
      }
    }

    fetchHistoricalData()
    return () => controller.abort();
  }, [token, timeframe])

  const tfOptions = ['1D', '1W', '1M', '3M', '6M', '1Y', '5Y'];

  const todayChange = quote ? (quote.last_price - quote.ohlc.close) : null;
  const todayChangePct = quote && quote.ohlc.close ? ((todayChange / quote.ohlc.close) * 100).toFixed(2) : null;

  const fmtNum = (n) => n != null ? n.toFixed(2) : '—';

  const rsiColor = (val) => {
    if (val == null) return '';
    if (val >= 70) return 'negative';
    if (val <= 30) return 'positive';
    return '';
  };

  const rsiLabel = (val) => {
    if (val == null) return '';
    if (val >= 70) return 'Bearish (Overbought)';
    if (val <= 30) return 'Bullish (Oversold)';
    return 'Neutral';
  };

  // Generic MA signal
  const maSignal = (maVal) => {
    if (maVal == null || indicators?.currentPrice == null) return { text: '', color: '' };
    if (indicators.currentPrice > maVal) return { text: 'Bullish', color: 'positive' };
    if (indicators.currentPrice < maVal) return { text: 'Bearish', color: 'negative' };
    return { text: 'Neutral', color: '' };
  };

  // MACD signal
  const macdSignal = (macd, signal) => {
    if (macd == null || signal == null) return { text: '', color: '' };
    if (macd > signal) return { text: 'Bullish', color: 'positive' };
    if (macd < signal) return { text: 'Bearish', color: 'negative' };
    return { text: 'Neutral', color: '' };
  };

  // Bollinger Bands signals
  const bbUpperSignal = (bb) => {
    if (!bb || indicators?.currentPrice == null) return { text: 'Neutral', color: '' };
    if (indicators.currentPrice > bb.upper) return { text: 'Bearish (Overbought)', color: 'negative' };
    return { text: 'Neutral', color: '' };
  };

  const bbLowerSignal = (bb) => {
    if (!bb || indicators?.currentPrice == null) return { text: 'Neutral', color: '' };
    if (indicators.currentPrice < bb.lower) return { text: 'Bullish (Oversold)', color: 'positive' };
    return { text: 'Neutral', color: '' };
  };

  // MACD signals for Histogram and Signal line
  const macdHistSignal = (hist) => {
    if (hist == null) return { text: 'Neutral', color: '' };
    if (hist > 0) return { text: 'Bullish', color: 'positive' };
    if (hist < 0) return { text: 'Bearish', color: 'negative' };
    return { text: 'Neutral', color: '' };
  };

  const macdSignalLineStatus = (val) => {
    if (val == null) return { text: 'Neutral', color: '' };
    if (val > 0) return { text: 'Bullish', color: 'positive' };
    if (val < 0) return { text: 'Bearish', color: 'negative' };
    return { text: 'Neutral', color: '' };
  };

  if (loading) return <div className="loader"></div>;

  return (
    <div className="dashboard-layout">
      <header className="header" style={{ marginBottom: '1rem', borderBottom: 'none' }}>
        <div>
          <button onClick={() => navigate(-1)} style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-primary)', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer', marginBottom: '1rem' }}>
            &larr; Back to Dashboard
          </button>
          <h1 style={{ margin: 0 }}>
            {kiteName
              || fundamentals?.price?.longName
              || fundamentals?.price?.shortName
              || symbol
              || 'Instrument'}
          </h1>
          {(kiteName || fundamentals?.price?.longName || fundamentals?.price?.shortName) && symbol && (
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 600, letterSpacing: '0.5px', marginTop: '0.25rem' }}>
              {symbol}
            </div>
          )}
        </div>
      </header>

      {/* Today's Change */}
      {quote && (
        <section className="grid" style={{ marginBottom: '1rem' }}>
          <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
            <span className="label" style={{ fontSize: '0.85rem' }}>Current Price</span>
            <span className="value" style={{ fontSize: '1.25rem' }}>₹{quote.last_price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
          </div>
          <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
            <span className="label" style={{ fontSize: '0.85rem' }}>Prev. Close</span>
            <span className="value" style={{ fontSize: '1.25rem' }}>₹{quote.ohlc.close.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
          </div>
          <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
            <span className="label" style={{ fontSize: '0.85rem' }}>Today's Change</span>
            <span className={`value ${todayChange >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.25rem' }}>
              {todayChange >= 0 ? '+' : ''}₹{todayChange.toFixed(2)} ({todayChangePct}%)
            </span>
          </div>
        </section>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '1rem', borderBottom: '1px solid var(--border)', marginBottom: '1.5rem', paddingBottom: '0.25rem' }}>
        <button
          onClick={() => setActiveTab('technicals')}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'technicals' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'technicals' ? 'var(--text-primary)' : 'var(--text-secondary)',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontWeight: activeTab === 'technicals' ? 'bold' : 'normal',
            transition: 'all 0.2s',
            fontSize: '1rem'
          }}
        >
          Technicals
        </button>
        <button
          onClick={() => setActiveTab('fundamentals')}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'fundamentals' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'fundamentals' ? 'var(--text-primary)' : 'var(--text-secondary)',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontWeight: activeTab === 'fundamentals' ? 'bold' : 'normal',
            transition: 'all 0.2s',
            fontSize: '1rem'
          }}
        >
          Fundamentals
        </button>
        <button
          onClick={() => setActiveTab('quarterly')}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'quarterly' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'quarterly' ? 'var(--text-primary)' : 'var(--text-secondary)',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontWeight: activeTab === 'quarterly' ? 'bold' : 'normal',
            transition: 'all 0.2s',
            fontSize: '1rem'
          }}
        >
          Quarterly Results
        </button>
        <button
          onClick={() => setActiveTab('cashflow')}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'cashflow' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'cashflow' ? 'var(--text-primary)' : 'var(--text-secondary)',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontWeight: activeTab === 'cashflow' ? 'bold' : 'normal',
            transition: 'all 0.2s',
            fontSize: '1rem'
          }}
        >
          Cashflow Chart
        </button>
      </div>

      {activeTab === 'technicals' && (
        <>
          {/* Period stats */}
          {!loading && !error && data.length > 0 && timeframe !== '1D' && (
            <section className="grid" style={{ marginBottom: '1rem' }}>
              {(() => {
                const startPrice = data[0].close;
                const endPrice = quote ? quote.last_price : data[data.length - 1].close;
                const maxHigh = Math.max(...data.map(d => d.high));
                const minLow = Math.min(...data.map(d => d.low));
                const ret = endPrice - startPrice;
                const retPct = ((ret / startPrice) * 100).toFixed(2);
                return (
                  <>
                    <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                      <span className="label" style={{ fontSize: '0.85rem' }}>Period High</span>
                      <span className="value" style={{ fontSize: '1.25rem' }}>₹{maxHigh.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                      <span className="label" style={{ fontSize: '0.85rem' }}>Period Low</span>
                      <span className="value" style={{ fontSize: '1.25rem' }}>₹{minLow.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                      <span className="label" style={{ fontSize: '0.85rem' }}>Period Returns</span>
                      <span className={`value ${ret >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.25rem' }}>
                        {ret >= 0 ? '+' : ''}₹{ret.toLocaleString('en-IN', { maximumFractionDigits: 2 })} ({retPct}%)
                      </span>
                    </div>
                  </>
                );
              })()}
            </section>
          )}

          {/* Chart Configuration */}
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontWeight: 'bold', color: 'var(--text-secondary)', marginRight: '0.5rem' }}></span>
            {tfOptions.map(tf => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                style={{
                  background: timeframe === tf ? 'var(--accent)' : 'var(--bg-panel)',
                  color: timeframe === tf ? '#fff' : 'var(--text-primary)',
                  border: '1px solid var(--border)',
                  borderRadius: '4px',
                  padding: '0.4rem 0.8rem',
                  cursor: 'pointer',
                  fontWeight: timeframe === tf ? 'bold' : 'normal',
                  transition: 'all 0.2s'
                }}
              >
                {tf}
              </button>
            ))}
          </div>

          {/* Chart */}
          <section className="glass-panel" style={{ height: '400px', padding: '1.5rem 1rem 1rem 1rem' }}>
            {loading ? (
              <div className="loader"></div>
            ) : error ? (
              <p className="negative">{error}</p>
            ) : data.length === 0 ? (
              <p>No historical data available for this timeline.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <XAxis dataKey="date" stroke="var(--text-secondary)" tick={{ fill: 'var(--text-secondary)' }} />
                  <YAxis domain={['auto', 'auto']} stroke="var(--text-secondary)" tick={{ fill: 'var(--text-secondary)' }} />
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'var(--bg-dark)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                    itemStyle={{ color: 'var(--accent)' }}
                  />
                  <Legend />
                  <Line type="monotone" name="Price" dataKey="close" stroke="var(--accent)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </section>

          {/* Technical Indicators */}
          {indicators && (
            <section className="glass-panel" style={{ marginTop: '1rem' }}>
              <h2 style={{ marginBottom: '1rem' }}>Technical Indicators (1D timeframe)</h2>
              <div className="grid" style={{ gap: '0.75rem' }}>
                {/* RSI */}
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>RSI (14)</span>
                  <span className={`value ${rsiColor(indicators.indicators.rsi.rsi14)}`} style={{ fontSize: '1.25rem' }}>
                    {fmtNum(indicators.indicators.rsi.rsi14)}
                  </span>
                  <span className="label" style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {rsiLabel(indicators.indicators.rsi.rsi14)}
                  </span>
                </div>

                {/* SMA 5 */}
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>SMA 5</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.sma.sma5)}</span>
                  <span className={`label ${maSignal(indicators.indicators.sma.sma5).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {maSignal(indicators.indicators.sma.sma5).text}
                  </span>
                </div>

                {/* SMA 20 */}
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>SMA 20</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.sma.sma20)}</span>
                  <span className={`label ${maSignal(indicators.indicators.sma.sma20).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {maSignal(indicators.indicators.sma.sma20).text}
                  </span>
                </div>

                {/* SMA 50 */}
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>SMA 50</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.sma.sma50)}</span>
                  <span className={`label ${maSignal(indicators.indicators.sma.sma50).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {maSignal(indicators.indicators.sma.sma50).text}
                  </span>
                </div>

                {/* SMA 200 */}
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>SMA 200</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.sma.sma200)}</span>
                  <span className={`label ${maSignal(indicators.indicators.sma.sma200).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {maSignal(indicators.indicators.sma.sma200).text}
                  </span>
                </div>

                {/* EMA 12 */}
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>EMA 12</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.ema.ema12)}</span>
                  <span className={`label ${maSignal(indicators.indicators.ema.ema12).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {maSignal(indicators.indicators.ema.ema12).text}
                  </span>
                </div>

                {/* EMA 26 */}
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>EMA 26</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.ema.ema26)}</span>
                  <span className={`label ${maSignal(indicators.indicators.ema.ema26).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {maSignal(indicators.indicators.ema.ema26).text}
                  </span>
                </div>

                {/* MACD */}
                {indicators.indicators.macd && (
                  <>
                    <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                      <span className="label" style={{ fontSize: '0.85rem' }}>MACD Line</span>
                      <span className={`value ${indicators.indicators.macd.MACD >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.25rem' }}>
                        {fmtNum(indicators.indicators.macd.MACD)}
                      </span>
                      <span className={`label ${macdSignal(indicators.indicators.macd.MACD, indicators.indicators.macd.signal).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        {macdSignal(indicators.indicators.macd.MACD, indicators.indicators.macd.signal).text}
                      </span>
                    </div>
                    <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                      <span className="label" style={{ fontSize: '0.85rem' }}>MACD Signal</span>
                      <span className="value" style={{ fontSize: '1.25rem' }}>{fmtNum(indicators.indicators.macd.signal)}</span>
                      <span className={`label ${macdSignalLineStatus(indicators.indicators.macd.signal).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        {macdSignalLineStatus(indicators.indicators.macd.signal).text}
                      </span>
                    </div>
                    <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                      <span className="label" style={{ fontSize: '0.85rem' }}>MACD Histogram</span>
                      <span className={`value ${indicators.indicators.macd.histogram >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.25rem' }}>
                        {fmtNum(indicators.indicators.macd.histogram)}
                      </span>
                      <span className={`label ${macdHistSignal(indicators.indicators.macd.histogram).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        {macdHistSignal(indicators.indicators.macd.histogram).text}
                      </span>
                    </div>
                  </>
                )}

                {/* Bollinger Bands */}
                {indicators.indicators.bollingerBands && (
                  <>
                    <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                      <span className="label" style={{ fontSize: '0.85rem' }}>BB Upper</span>
                      <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.bollingerBands.upper)}</span>
                      <span className={`label ${bbUpperSignal(indicators.indicators.bollingerBands).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        {bbUpperSignal(indicators.indicators.bollingerBands).text}
                      </span>
                    </div>
                    <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                      <span className="label" style={{ fontSize: '0.85rem' }}>BB Middle</span>
                      <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.bollingerBands.middle)}</span>
                      <span className={`label ${maSignal(indicators.indicators.bollingerBands.middle).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        {maSignal(indicators.indicators.bollingerBands.middle).text}
                      </span>
                    </div>
                    <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                      <span className="label" style={{ fontSize: '0.85rem' }}>BB Lower</span>
                      <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.bollingerBands.lower)}</span>
                      <span className={`label ${bbLowerSignal(indicators.indicators.bollingerBands).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        {bbLowerSignal(indicators.indicators.bollingerBands).text}
                      </span>
                    </div>
                  </>
                )}
              </div>
            </section>
          )}

          {activeTab === 'technicals' && !indicators && !loading && !error && (
            <section className="glass-panel" style={{ marginTop: '1rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
              <p>Calculated technical indicators are currently loading or unavailable for this instrument.</p>
            </section>
          )}

        </>
      )}

      {activeTab === 'fundamentals' && (
        <>
          {/* Fundamental Analysis */}
          {fundamentals ? (
            <section className="glass-panel" style={{ marginTop: '1rem', background: 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.01) 100%)' }}>
              <h2 style={{ marginBottom: '1rem' }}>Fundamental Analysis (Yahoo Finance)</h2>

              {fundamentals.assetProfile?.longBusinessSummary && (
                <div style={{ marginBottom: '1.5rem', padding: '1rem', background: 'var(--bg-dark)', borderRadius: '8px', lineHeight: '1.6', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                  <strong style={{ color: 'var(--text-primary)', display: 'block', marginBottom: '0.5rem' }}>Company Overview</strong>
                  {fundamentals.assetProfile.longBusinessSummary}
                </div>
              )}

              <div className="grid" style={{ gap: '0.75rem' }}>
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>Market Cap</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>{fundamentals.summaryDetail?.marketCap ? `₹${(fundamentals.summaryDetail.marketCap / 10000000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr` : '—'}</span>
                </div>

                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>Trailing P/E</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>{fmtNum(fundamentals.summaryDetail?.trailingPE)}</span>
                </div>

                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>Forward P/E</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>{fmtNum(fundamentals.summaryDetail?.forwardPE)}</span>
                </div>

                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>Price to Book (P/B)</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>{fmtNum(fundamentals.defaultKeyStatistics?.priceToBook)}</span>
                </div>

                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>Dividend Yield</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>{fundamentals.summaryDetail?.dividendYield !== undefined ? `${(fundamentals.summaryDetail.dividendYield * 100).toFixed(2)}%` : '—'}</span>
                </div>

                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>PEG Ratio</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>{fmtNum(fundamentals.defaultKeyStatistics?.pegRatio)}</span>
                </div>

                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>52W High</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(fundamentals.summaryDetail?.fiftyTwoWeekHigh)}</span>
                </div>

                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>52W Low</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(fundamentals.summaryDetail?.fiftyTwoWeekLow)}</span>
                </div>

                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>Profit Margin</span>
                  <span className={`value ${fundamentals.financialData?.profitMargins >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.25rem' }}>
                    {fundamentals.financialData?.profitMargins !== undefined ? `${(fundamentals.financialData.profitMargins * 100).toFixed(2)}%` : '—'}
                  </span>
                </div>
              </div>
            </section>
          ) : (
            <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>Fundamental data is not available for this instrument.</p>
          )}
        </>
      )}

      {activeTab === 'quarterly' && (() => {
        // ── Quarterly Results — screener.in-backed ──────────────────────
        // Switched from Yahoo to screener.in for this view. Screener gives 13
        // consecutive quarters with no gaps (Yahoo's fundamentalsTimeSeries
        // randomly misses quarters for some Indian tickers — JIOFIN/HINDZINC
        // were both showing a missing Q2 FY26). Values arrive already in ₹ Cr.
        const isReady = Array.isArray(screenerQuarterly?.quarters);
        const quarters = isReady ? [...screenerQuarterly.quarters].sort((a, b) => a.sortKey - b.sortKey) : [];

        const labelFromQFy = (q, fy) => `Q${q} FY${String(fy).slice(-2)}`;
        const prevQuarter = (q, fy) => q === 1 ? { q: 4, fy: fy - 1 } : { q: q - 1, fy };
        const prevYearQuarter = (q, fy) => ({ q, fy: fy - 1 });

        // Build a label → quarter-row map. Screener rows already carry q/fy/label.
        const byLabel = {};
        for (const row of quarters) byLabel[row.label] = row;

        // 4 consecutive labels ending at the latest available quarter.
        const latest = quarters.length > 0 ? quarters[quarters.length - 1] : null;
        const columns = [];
        if (latest) {
          let cur = { q: latest.q, fy: latest.fy };
          const stack = [];
          for (let i = 0; i < 4; i++) {
            stack.unshift({ ...cur, label: labelFromQFy(cur.q, cur.fy) });
            cur = prevQuarter(cur.q, cur.fy);
          }
          columns.push(...stack);
        }

        // Operating Margin: screener exposes OPM directly as `opm` (percent
        // already). Fall back to computed margin if absent.
        const opMarginOf = (row) => {
          if (!row) return null;
          if (row.opm != null) return row.opm;
          if (row.totalIncome && row.operatingProfit != null) return (row.operatingProfit / row.totalIncome) * 100;
          return null;
        };

        // ── Formatters ────────────────────────────────────────────────
        // Screener serves numbers already in ₹ Cr (no /1e7 needed, unlike Yahoo).
        const fmtCr = (v) => {
          if (v == null || v === 0) return '—';
          return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: Math.abs(v) < 1000 ? 1 : 0 })} Cr`;
        };
        const fmtEPS = (v) => (v == null || v === 0) ? '—' : `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
        const fmtPct = (v) => v == null ? '—' : `${v.toFixed(1)}%`;

        // Pair growth = computed once per cell, colour-graded by magnitude.
        const growthPill = (curr, prev) => {
          if (curr == null || prev == null || prev === 0) return null;
          const pct = ((curr - prev) / Math.abs(prev)) * 100;
          const positive = pct >= 0;
          const abs = Math.abs(pct);
          let color;
          if (abs < 5)        color = positive ? '#34d399' : '#fca5a5';
          else if (abs < 15)  color = positive ? '#10b981' : '#ef4444';
          else                color = positive ? '#059669' : '#dc2626';
          return {
            label: `${positive ? '↑' : '↓'}${abs.toFixed(1)}%`,
            color,
            weight: abs >= 15 ? 800 : 700,
          };
        };
        // Margin uses a percentage-points pill instead of relative growth.
        const marginPill = (curr, prev) => {
          if (curr == null || prev == null) return null;
          const diff = curr - prev;
          const positive = diff >= 0;
          const abs = Math.abs(diff);
          let color;
          if (abs < 1)        color = positive ? '#34d399' : '#fca5a5';
          else if (abs < 5)   color = positive ? '#10b981' : '#ef4444';
          else                color = positive ? '#059669' : '#dc2626';
          return {
            label: `${positive ? '+' : '−'}${abs.toFixed(1)} pp`,
            color,
            weight: abs >= 5 ? 800 : 700,
          };
        };

        // Row spec mapped to screener.in field names.
        const rows = [
          { key: 'totalIncome',     label: 'Total Income',     fmt: fmtCr,  get: r => r?.totalIncome,     pill: growthPill },
          { key: 'operatingProfit', label: 'Operating Profit', fmt: fmtCr,  get: r => r?.operatingProfit, pill: growthPill },
          { key: 'operatingMargin', label: 'Operating Margin', fmt: fmtPct, get: r => opMarginOf(r),     pill: marginPill },
          { key: 'netProfit',       label: 'Net Profit',       fmt: fmtCr,  get: r => r?.netProfit,       pill: growthPill },
          { key: 'eps',             label: 'EPS',              fmt: fmtEPS, get: r => r?.eps,             pill: growthPill },
        ];

        // Sparkline data per row (4 numbers, one per visible column; nulls allowed).
        // Values are already in their natural units (₹ Cr or ₹ for EPS).
        const sparklineFor = (row) => columns.map(c => {
          const r = byLabel[c.label];
          const v = row.get(r);
          return { v: v == null ? null : v };
        });

        // Lightweight sparkline — no axes, no grid, just the line + endpoint dot.
        const Sparkline = ({ points }) => {
          const valid = points.filter(p => p.v != null);
          if (valid.length < 2) {
            return <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>—</span>;
          }
          const last = valid[valid.length - 1].v;
          const first = valid[0].v;
          const color = last >= first ? '#10b981' : '#ef4444';
          return (
            <div style={{ width: '70px', height: '28px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={points}>
                  <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          );
        };

        return (
          <section className="glass-panel" style={{ marginTop: '1rem', padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div>
                <h2 style={{ margin: 0 }}>Quarterly Results</h2>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  Last 4 consecutive quarters · YoY · QoQ · Screener.in (standalone)
                </span>
              </div>
              {columns.length > 0 && (
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {columns[0].label} → {columns[columns.length - 1].label}
                </span>
              )}
            </div>

            {!isReady || columns.length === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--text-secondary)', marginTop: '1.5rem' }}>
                {screenerError
                  ? `Screener.in data unavailable: ${screenerError}`
                  : screenerQuarterly == null
                    ? 'Loading from Screener.in…'
                    : 'Quarterly comparison data is not available for this instrument.'}
              </p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '0.9rem' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '0.65rem 0.75rem', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.72rem', letterSpacing: '0.5px', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>
                        Metric
                      </th>
                      {columns.map(col => (
                        <th key={col.label} style={{ textAlign: 'right', padding: '0.65rem 0.75rem', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.72rem', letterSpacing: '0.5px', borderBottom: '1px solid var(--border)' }}>
                          {col.label}
                        </th>
                      ))}
                      <th style={{ textAlign: 'right', padding: '0.65rem 0.75rem', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.72rem', letterSpacing: '0.5px', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>
                        Trend
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => {
                      const sparkPoints = sparklineFor(row);
                      return (
                        <tr key={row.key}>
                          <td style={{ textAlign: 'left', padding: '0.85rem 0.75rem', color: 'var(--text-primary)', fontWeight: 600, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            {row.label}
                          </td>
                          {columns.map((col, idx) => {
                            const currRow = byLabel[col.label];
                            const value = row.get(currRow);
                            // QoQ → prior column in the visible 4-window
                            const qoqCol = idx > 0 ? columns[idx - 1] : null;
                            const qoqValue = qoqCol ? row.get(byLabel[qoqCol.label]) : undefined;
                            // YoY → same-quarter previous year (looked up regardless of visibility)
                            const yoy = prevYearQuarter(col.q, col.fy);
                            const yoyValue = row.get(byLabel[labelFromQFy(yoy.q, yoy.fy)]);
                            const yoyPill = row.pill(value, yoyValue);
                            const qoqPill = qoqValue !== undefined ? row.pill(value, qoqValue) : null;

                            return (
                              <td key={col.label} style={{ textAlign: 'right', padding: '0.85rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.04)', verticalAlign: 'top' }}>
                                <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                                  {row.fmt(value)}
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.1rem', marginTop: '0.2rem', fontSize: '0.7rem' }}>
                                  {yoyPill ? (
                                    <span title="Year-on-Year" style={{ color: yoyPill.color, fontWeight: yoyPill.weight }}>
                                      <span style={{ color: 'var(--text-secondary)', fontWeight: 500, marginRight: '3px' }}>YoY</span>
                                      {yoyPill.label}
                                    </span>
                                  ) : (
                                    <span style={{ color: 'var(--text-secondary)' }}>YoY —</span>
                                  )}
                                  {qoqPill ? (
                                    <span title="Quarter-on-Quarter" style={{ color: qoqPill.color, fontWeight: qoqPill.weight }}>
                                      <span style={{ color: 'var(--text-secondary)', fontWeight: 500, marginRight: '3px' }}>QoQ</span>
                                      {qoqPill.label}
                                    </span>
                                  ) : (
                                    idx > 0 && <span style={{ color: 'var(--text-secondary)' }}>QoQ —</span>
                                  )}
                                </div>
                              </td>
                            );
                          })}
                          <td style={{ textAlign: 'right', padding: '0.85rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <div style={{ display: 'inline-block' }}>
                              <Sparkline points={sparkPoints} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ marginTop: '0.75rem', fontSize: '0.7rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                  Source: screener.in (standalone, ₹ Cr). Operating Margin uses percentage-point change. Cashflow Chart tab still uses Yahoo (consolidated) — small numerical differences between the two tabs are expected.
                </div>
              </div>
            )}
          </section>
        );
      })()}

      {activeTab === 'cashflow' && (
        <section className="glass-panel" style={{ marginTop: '1rem', height: '500px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 style={{ margin: 0 }}>Financials / Cashflow Analysis (Yahoo Finance)</h2>
            <div style={{ display: 'flex', gap: '0.5rem', background: 'var(--bg-dark)', padding: '0.25rem', borderRadius: '4px' }}>
              <button
                onClick={() => setCashflowType('quarterly')}
                style={{
                  background: cashflowType === 'quarterly' ? 'var(--accent)' : 'transparent',
                  color: cashflowType === 'quarterly' ? '#fff' : 'var(--text-secondary)',
                  border: 'none',
                  padding: '4px 12px',
                  borderRadius: '3px',
                  cursor: 'pointer',
                  fontSize: '0.85rem'
                }}
              >
                Quarterly
              </button>
              <button
                onClick={() => setCashflowType('annual')}
                style={{
                  background: cashflowType === 'annual' ? 'var(--accent)' : 'transparent',
                  color: cashflowType === 'annual' ? '#fff' : 'var(--text-secondary)',
                  border: 'none',
                  padding: '4px 12px',
                  borderRadius: '3px',
                  cursor: 'pointer',
                  fontSize: '0.85rem'
                }}
              >
                Yearly
              </button>
            </div>
          </div>

          {cashflow && cashflow.length > 0 ? (
            <div style={{ flex: 1, minHeight: 0 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={cashflow.slice().reverse()} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    stroke="var(--text-secondary)"
                    tickFormatter={(val) => {
                      const d = new Date(val);
                      return cashflowType === 'quarterly' ? `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}` : d.getFullYear();
                    }}
                  />
                  <YAxis
                    stroke="var(--text-secondary)"
                    tickFormatter={(val) => `₹${(val / 10000000).toFixed(0)}Cr`}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'var(--bg-dark)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                    formatter={(value, name) => [`₹${(value / 10000000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`, name]}
                    labelFormatter={(label) => new Date(label).toDateString()}
                  />
                  <Legend />
                  <Bar dataKey="totalRevenue" name="Total Revenue" fill="#3498db" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="netIncome" name="Net Income" fill="#f39c12" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="operatingCashFlow" name="Operating Cashflow" fill="var(--accent)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="investingCashFlow" name="Investing Cashflow" fill="#a29bfe" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="financingCashFlow" name="Financing Cashflow" fill="var(--danger)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="freeCashFlow" name="Free Cashflow" fill="var(--success)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>Cashflow data is not available for this instrument.</p>
          )}
        </section>
      )}
    </div>
  )
}

export default Instrument
