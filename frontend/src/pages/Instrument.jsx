import { useState, useEffect } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { format, parseISO } from 'date-fns'

function Instrument() {
  const { token } = useParams()
  const [searchParams] = useSearchParams()
  const symbol = searchParams.get('symbol')
  const navigate = useNavigate()

  const [data, setData] = useState([])
  const [quote, setQuote] = useState(null)
  const [indicators, setIndicators] = useState(null)
  const [fundamentals, setFundamentals] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [timeframe, setTimeframe] = useState('1M')

  // Fetch live quote
  useEffect(() => {
    if (!symbol) return;
    const fetchQuote = async () => {
      try {
        const res = await fetch('http://localhost:3001/api/quotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instruments: [`NSE:${symbol}`] })
        });
        const resData = await res.json();
        if (resData?.content?.[0]?.text) {
          const parsed = JSON.parse(resData.content[0].text);
          const key = `NSE:${symbol}`;
          if (parsed[key]) setQuote(parsed[key]);
        }
      } catch (e) { }
    }
    fetchQuote();
  }, [symbol])

  // Fetch indicators
  useEffect(() => {
    let retries = 0;
    const maxRetries = 2;
    const fetchIndicators = async () => {
      try {
        const res = await fetch(`http://localhost:3001/api/indicators/${token}`)
        if (res.ok) {
          const data = await res.json()
          setIndicators(data)
        } else if (res.status === 404 && retries < maxRetries) {
          // If backend is still warming the cache, try again once more in 3 seconds
          retries++;
          setTimeout(fetchIndicators, 3000);
        }
      } catch (e) {
        if (retries < maxRetries) {
          retries++;
          setTimeout(fetchIndicators, 3000);
        }
      }
    }
    fetchIndicators()
  }, [token])

  // Fetch fundamentals
  useEffect(() => {
    if (!symbol) return;
    const fetchFundamentals = async () => {
      try {
        const res = await fetch(`http://localhost:3001/api/fundamentals/${symbol}`);
        if (res.ok) {
          const data = await res.json();
          setFundamentals(data);
        }
      } catch (e) {
        console.error("Failed to fetch fundamentals", e);
      }
    };
    fetchFundamentals();
  }, [symbol]);

  // Fetch historical data
  useEffect(() => {
    const fetchHistoricalData = async () => {
      try {
        setLoading(true)
        setError(null)
        const res = await fetch(`http://localhost:3001/api/historical/${token}?tf=${timeframe}&t=${Date.now()}`)
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
        setError('Error connecting to backend API.')
      } finally {
        setLoading(false)
      }
    }

    fetchHistoricalData()
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

  // Bollinger Bands signal
  const bbSignal = (bb) => {
    if (!bb || indicators?.currentPrice == null) return { text: 'Neutral', color: '' };
    if (indicators.currentPrice > bb.upper) return { text: 'Bearish (Overbought)', color: 'negative' };
    if (indicators.currentPrice < bb.lower) return { text: 'Bullish (Oversold)', color: 'positive' };
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
          <h1>{symbol || 'Instrument'}</h1>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', flexWrap: 'wrap' }}>
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

      {/* Chart */}
      <section className="glass-panel" style={{ height: '400px' }}>
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
          <h2 style={{ marginBottom: '1rem' }}>Technical Indicators (1D time frame)</h2>
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
                </div>
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>MACD Histogram</span>
                  <span className={`value ${indicators.indicators.macd.histogram >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.25rem' }}>
                    {fmtNum(indicators.indicators.macd.histogram)}
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
                  <span className={`label ${bbSignal(indicators.indicators.bollingerBands).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {bbSignal(indicators.indicators.bollingerBands).text}
                  </span>
                </div>
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>BB Middle</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.bollingerBands.middle)}</span>
                </div>
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>BB Lower</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.bollingerBands.lower)}</span>
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {/* Fundamental Analysis */}
      {fundamentals && (
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
      )}

      {!indicators && !loading && !error && (
        <section className="glass-panel" style={{ marginTop: '1rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          <p>Calculated technical indicators are currently loading or unavailable for this instrument.</p>
        </section>
      )}
    </div>
  )
}

export default Instrument
