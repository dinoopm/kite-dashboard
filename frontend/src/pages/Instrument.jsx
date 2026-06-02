import { useState, useEffect } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { format, parseISO } from 'date-fns'
import { fetchWithAbort } from '../hooks/useFetchWithAbort'
import AlertRow from '../components/alerts/AlertRow'
import ConvictionModal from '../components/alerts/ConvictionModal'
import TradePlanModal from '../components/alerts/TradePlanModal'

// Two-panel shareholding view: left selects a quarter and shows horizontal
// % bars per category; right selects a category and shows a vertical bar
// history across all available quarters.
function ShareholdingPanel({ payload, error }) {
  const quarters = Array.isArray(payload?.quarters)
    ? [...payload.quarters].sort((a, b) => a.sortKey - b.sortKey)
    : [];

  // Derive "Retail and Others" as Public + Others so the breakdown matches
  // the conventional Indian disclosure (retail investors + small bucket).
  const enriched = quarters.map(q => ({
    ...q,
    retailAndOthers: (q.public != null || q.others != null)
      ? +(((q.public || 0) + (q.others || 0)).toFixed(2))
      : null,
  }));

  // Display order + colors mirror the reference layout. Sub-rows like
  // Mutual Funds / Other Domestic Institutions are preferred when available;
  // we fall back to the parent DII total otherwise.
  const hasMF = enriched.some(q => q.mutualFunds != null && q.mutualFunds > 0);
  const hasODI = enriched.some(q => q.otherDIIs != null && q.otherDIIs > 0);

  // `alwaysShow` keeps core categories visible even when screener reports
  // them as 0 (e.g. HDFC Bank post-merger has 0% promoter holding — without
  // this flag the row silently disappears). Optional categories like
  // Government still get filtered out when uniformly zero to avoid clutter.
  const CATEGORIES = [
    { key: 'promoters',          label: 'Total Promoter Holding', color: '#4f8df9', alwaysShow: true },
    ...(hasMF
      ? [{ key: 'mutualFunds',         label: 'Mutual Funds',                color: '#4f8df9' }]
      : []),
    ...(hasODI
      ? [{ key: 'otherDIIs',           label: 'Other Domestic Institutions', color: '#bfdcff' }]
      : []),
    ...(!hasMF && !hasODI
      ? [{ key: 'diis',               label: 'Domestic Institutions',        color: '#4f8df9' }]
      : []),
    { key: 'fiis',               label: 'Foreign Institutions',  color: '#4f8df9', alwaysShow: true },
    { key: 'government',         label: 'Government',            color: '#bfdcff' },
    { key: 'retailAndOthers',    label: 'Retail and Others',     color: '#4f8df9', alwaysShow: true },
  ].filter(c => c.alwaysShow || enriched.some(q => q[c.key] != null && q[c.key] > 0));

  // Selection state. `null` means "use default" — resolved below by looking
  // up the latest quarter / preferred category at render time, so we don't
  // need an effect to seed defaults after payload arrives.
  const [selectedQuarterKey, setSelectedQuarterKey] = useState(null);
  const [selectedCategoryKey, setSelectedCategoryKey] = useState(null);

  if (quarters.length === 0) {
    return (
      <section className="glass-panel" style={{ marginTop: '1rem', padding: '1.5rem' }}>
        <h2 style={{ margin: '0 0 0.5rem 0' }}>Shareholding</h2>
        <p style={{ textAlign: 'center', color: 'var(--text-secondary)', marginTop: '1rem' }}>
          {error
            ? `Shareholding unavailable: ${error}`
            : payload == null ? 'Loading from Screener.in…' : 'Shareholding data is not available for this instrument.'}
        </p>
      </section>
    );
  }

  // Quarter tab labels: show "Mon YYYY" (e.g. "Mar 2026") for the last 4 quarters
  const monthName = (m) => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1];
  const lastFourQuarters = enriched.slice(-4);
  const selectedQuarter = (selectedQuarterKey != null && enriched.find(q => q.sortKey === selectedQuarterKey))
    || enriched[enriched.length - 1];

  // Max % across visible categories in the selected quarter — for bar scaling
  const maxPct = Math.max(...CATEGORIES.map(c => selectedQuarter[c.key] || 0), 10);

  // Default to FIIs if present (matches reference layout), else first available
  const selectedCategory = (selectedCategoryKey != null && CATEGORIES.find(c => c.key === selectedCategoryKey))
    || CATEGORIES.find(c => c.key === 'fiis')
    || CATEGORIES[0];
  const historyData = enriched.map(q => ({
    label: `${monthName(q.month)} ${String(q.year).slice(-2)}`,
    fullLabel: `${monthName(q.month)} ${q.year}`,
    value: q[selectedCategory.key],
    sortKey: q.sortKey,
  }));

  return (
    <section className="glass-panel" style={{ marginTop: '1rem', padding: '1.5rem' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
        gap: '1.5rem',
      }}>
        {/* ── Left: snapshot for selected quarter ─────────────────── */}
        <div>
          <h3 style={{ margin: '0 0 0.85rem 0', fontSize: '1.1rem' }}>Shareholding Pattern</h3>

          {/* Quarter selector tabs */}
          <div style={{
            display: 'flex',
            gap: 0,
            padding: '4px',
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            marginBottom: '1rem',
            flexWrap: 'wrap',
          }}>
            {lastFourQuarters.map(q => {
              const isSelected = q.sortKey === selectedQuarter.sortKey;
              return (
                <button
                  key={q.sortKey}
                  onClick={() => setSelectedQuarterKey(q.sortKey)}
                  style={{
                    flex: '1 1 auto',
                    padding: '0.5rem 0.75rem',
                    background: isSelected ? 'var(--text-primary)' : 'transparent',
                    color: isSelected ? 'var(--bg-dark)' : 'var(--text-secondary)',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '0.8rem',
                    fontWeight: isSelected ? 700 : 500,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    transition: 'all 0.15s',
                  }}
                >
                  {monthName(q.month)} {q.year}
                </button>
              );
            })}
          </div>

          {/* Horizontal % bars per category */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            {CATEGORIES.map(c => {
              const v = selectedQuarter[c.key];
              const pctOfMax = v == null ? 0 : (v / maxPct) * 100;
              return (
                <div key={c.key}>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-primary)', fontWeight: 600, marginBottom: '0.3rem' }}>
                    {c.label}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                    <div style={{
                      flex: 1,
                      height: '12px',
                      background: 'rgba(255,255,255,0.04)',
                      borderRadius: '3px',
                      overflow: 'hidden',
                    }}>
                      <div style={{
                        width: `${pctOfMax}%`,
                        height: '100%',
                        background: c.color,
                        transition: 'width 0.3s',
                      }} />
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-primary)', fontWeight: 600, minWidth: '52px', textAlign: 'right' }}>
                      {v == null ? '—' : `${v.toFixed(2)}%`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Right: history of selected category ─────────────────── */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.85rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Shareholding History</h3>
          </div>

          {/* Category selector dropdown */}
          <div style={{ marginBottom: '1rem' }}>
            <select
              value={selectedCategory.key}
              onChange={(e) => setSelectedCategoryKey(e.target.value)}
              style={{
                padding: '0.55rem 0.75rem',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                color: 'var(--text-primary)',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: 'pointer',
                outline: 'none',
                minWidth: '220px',
              }}
            >
              {CATEGORIES.map(c => (
                <option key={c.key} value={c.key} style={{ background: 'var(--bg-dark)' }}>{c.label}</option>
              ))}
            </select>
          </div>

          {/* Vertical bar chart of selected category over time */}
          <div style={{ width: '100%', height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={historyData} margin={{ top: 24, right: 8, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                  axisLine={{ stroke: 'var(--border)' }}
                  tickLine={false}
                />
                <YAxis
                  hide
                  domain={[0, (dataMax) => Math.max(dataMax * 1.18, 1)]}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: 'var(--bg-dark)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                  formatter={(value) => [value == null ? '—' : `${Number(value).toFixed(2)}%`, selectedCategory.label]}
                  labelFormatter={(_, payload) => payload?.[0]?.payload?.fullLabel || ''}
                  cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                />
                <Bar
                  dataKey="value"
                  radius={[2, 2, 0, 0]}
                  isAnimationActive={false}
                  cursor="pointer"
                  onClick={(d) => d?.sortKey != null && setSelectedQuarterKey(d.sortKey)}
                  label={{
                    position: 'top',
                    fill: 'var(--text-primary)',
                    fontSize: 11,
                    fontWeight: 600,
                    formatter: (v) => v == null ? '' : `${Number(v).toFixed(2)}%`,
                  }}
                >
                  {historyData.map((d) => (
                    <Cell
                      key={d.sortKey}
                      fill={d.sortKey === selectedQuarter.sortKey ? '#34d3a4' : 'rgba(52,211,164,0.28)'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </section>
  );
}

function Instrument() {
  const { token } = useParams()
  const [searchParams] = useSearchParams()
  const symbol = searchParams.get('symbol')
  const navigate = useNavigate()

  const [data, setData] = useState([])
  const [quote, setQuote] = useState(null)
  const [indicators, setIndicators] = useState(null)
  const [fundamentals, setFundamentals] = useState(null)
  // cashflow state retired — both tabs now use screener-backed state below.
  // Company name sourced from Kite (search_instruments) — populates faster than
  // Yahoo fundamentals and is canonical for Indian tickers.
  const [kiteName, setKiteName] = useState(null)
  // Quarterly Results scraped from screener.in (richer + denser than Yahoo for
  // Indian tickers — no gaps, 13 quarters of history typically).
  const [screenerQuarterly, setScreenerQuarterly] = useState(null)
  const [screenerError, setScreenerError] = useState(null)
  // Annual P&L from the same screener page — fetched lazily when the user
  // toggles the Results view from Quarterly to Yearly.
  const [screenerAnnual, setScreenerAnnual] = useState(null)
  const [screenerAnnualError, setScreenerAnnualError] = useState(null)
  const [resultPeriod, setResultPeriod] = useState('quarterly') // 'quarterly' | 'yearly'
  // Annual cashflow scraped from the same screener page (separate cache entry).
  // Yahoo's quarterly cashflow was synthesised; Indian companies only file
  // annual cashflow in standalone disclosures anyway.
  const [screenerCashflow, setScreenerCashflow] = useState(null)
  const [screenerCashflowError, setScreenerCashflowError] = useState(null)
  // Annual balance sheet — consolidated by default, server falls back to
  // standalone on 404 (small caps).
  const [screenerBalanceSheet, setScreenerBalanceSheet] = useState(null)
  const [screenerBalanceSheetError, setScreenerBalanceSheetError] = useState(null)
  // Quarterly shareholding pattern (Promoters / FIIs / DIIs / Public / Govt / Others).
  const [screenerShareholding, setScreenerShareholding] = useState(null)
  const [screenerShareholdingError, setScreenerShareholdingError] = useState(null)
  // Single-instrument technical alert (mirrors Alerts page rows)
  const [instrumentAlert, setInstrumentAlert] = useState(null)
  const [instrumentAlertError, setInstrumentAlertError] = useState(null)
  const [instrumentAlertLoading, setInstrumentAlertLoading] = useState(false)
  // Modals reused from Alerts page
  const [convictionStock, setConvictionStock] = useState(null)
  const [tradePlanStock, setTradePlanStock] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [timeframe, setTimeframe] = useState('1M')
  const [activeTab, setActiveTab] = useState('technicals')
  // cashflowType toggle removed — screener has only annual cashflow.

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
        const res = await fetchWithAbort(`/api/instrument-info/${encodeURIComponent(symbol)}`, { signal: controller.signal });
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
        const res = await fetchWithAbort(`/api/screener-quarterly/${encodeURIComponent(symbol)}`, { signal: controller.signal });
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

  // Reset annual P&L whenever the symbol changes so a stale previous-symbol
  // series never flashes before the lazy fetch below resolves.
  useEffect(() => {
    setScreenerAnnual(null);
    setScreenerAnnualError(null);
  }, [symbol])

  // Fetch annual P&L lazily — only once the user switches to the yearly view
  // (same screener page the quarterly call already warmed, so it's cheap).
  useEffect(() => {
    if (!symbol || resultPeriod !== 'yearly') return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort(`/api/screener-annual/${encodeURIComponent(symbol)}`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.years) && data.years.length > 0) {
            setScreenerAnnual(data);
          } else {
            setScreenerAnnualError('Screener returned no annual rows');
          }
        } else {
          const err = await res.json().catch(() => ({}));
          setScreenerAnnualError(err.error || `Screener fetch failed (${res.status})`);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        setScreenerAnnualError(e.message);
      }
    })();
    return () => controller.abort();
  }, [symbol, resultPeriod])

  // Fetch annual cashflow from screener.in (same page, separate parser).
  useEffect(() => {
    if (!symbol) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort(`/api/screener-cashflow/${encodeURIComponent(symbol)}`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.years) && data.years.length > 0) {
            setScreenerCashflow(data);
          } else {
            setScreenerCashflowError('Screener returned no cashflow rows');
          }
        } else {
          const err = await res.json().catch(() => ({}));
          setScreenerCashflowError(err.error || `Screener fetch failed (${res.status})`);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        setScreenerCashflowError(e.message);
      }
    })();
    return () => controller.abort();
  }, [symbol])

  // Fetch annual consolidated balance sheet from screener.in.
  useEffect(() => {
    if (!symbol) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort(`/api/screener-balance-sheet/${encodeURIComponent(symbol)}`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.years) && data.years.length > 0) {
            setScreenerBalanceSheet(data);
          } else {
            setScreenerBalanceSheetError('Screener returned no balance sheet rows');
          }
        } else {
          const err = await res.json().catch(() => ({}));
          setScreenerBalanceSheetError(err.error || `Screener fetch failed (${res.status})`);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        setScreenerBalanceSheetError(e.message);
      }
    })();
    return () => controller.abort();
  }, [symbol])

  // Fetch quarterly shareholding pattern from screener.in.
  useEffect(() => {
    if (!symbol) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort(`/api/screener-shareholding/${encodeURIComponent(symbol)}`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.quarters) && data.quarters.length > 0) {
            setScreenerShareholding(data);
          } else {
            setScreenerShareholdingError('Screener returned no shareholding rows');
          }
        } else {
          const err = await res.json().catch(() => ({}));
          setScreenerShareholdingError(err.error || `Screener fetch failed (${res.status})`);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        setScreenerShareholdingError(e.message);
      }
    })();
    return () => controller.abort();
  }, [symbol])

  // Reset alert state whenever the instrument changes so the next fetch
  // doesn't get blocked by the dedup guard below and stale data from the
  // previous symbol doesn't flash on the screen.
  useEffect(() => {
    setInstrumentAlert(null);
    setInstrumentAlertError(null);
  }, [symbol, token])

  // Fetch per-instrument technical alert. Only when the Technicals tab is
  // active so we don't hit the MCP quote service on every page load.
  useEffect(() => {
    if (!symbol || !token) return;
    if (activeTab !== 'technicals') return;
    if (instrumentAlert || instrumentAlertError) return;
    const controller = new AbortController();
    (async () => {
      try {
        setInstrumentAlertLoading(true);
        const res = await fetchWithAbort(
          `/api/instrument-alert/${encodeURIComponent(token)}?symbol=${encodeURIComponent(symbol)}`,
          { signal: controller.signal }
        );
        if (res.ok) {
          const data = await res.json();
          setInstrumentAlert(data);
        } else {
          const err = await res.json().catch(() => ({}));
          setInstrumentAlertError(err.error || `Alert fetch failed (${res.status})`);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        setInstrumentAlertError(e.message);
      } finally {
        setInstrumentAlertLoading(false);
      }
    })();
    return () => controller.abort();
  }, [symbol, token, activeTab, instrumentAlert, instrumentAlertError])

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
        const res = await fetchWithAbort(`/api/fundamentals/${encodeURIComponent(symbol)}`, { signal: controller.signal });
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

  // (Yahoo /api/cashflow fetch was here — removed when both Quarterly Results
  // and Cashflow Chart switched to screener.in. Backend route stays around
  // for now in case anything else hits it.)

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
          P&L
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
        <button
          onClick={() => setActiveTab('balanceSheet')}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'balanceSheet' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'balanceSheet' ? 'var(--text-primary)' : 'var(--text-secondary)',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontWeight: activeTab === 'balanceSheet' ? 'bold' : 'normal',
            transition: 'all 0.2s',
            fontSize: '1rem'
          }}
        >
          Balance Sheet
        </button>
        <button
          onClick={() => setActiveTab('shareholding')}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'shareholding' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'shareholding' ? 'var(--text-primary)' : 'var(--text-secondary)',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontWeight: activeTab === 'shareholding' ? 'bold' : 'normal',
            transition: 'all 0.2s',
            fontSize: '1rem'
          }}
        >
          Shareholding
        </button>
      </div>

      {activeTab === 'technicals' && (
        <>
          {/* Per-instrument technical alert — same AlertRow used on the
              Holdings Alerts page and Sector Drilldown. Holdings fields are
              hidden because this stock may not be in the user's portfolio. */}
          <section className="glass-panel terminal-alerts" style={{ marginBottom: '1rem', padding: '1.25rem' }}>
            <div style={{ marginBottom: '0.85rem' }}>
              <h3 style={{ margin: 0, fontSize: '1rem' }}>Technical Alerts</h3>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                Live signal stack · ADX, SuperTrend, RSI, VWAP, volume surge, trade plan
              </span>
            </div>
            {instrumentAlertLoading && !instrumentAlert ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '1.25rem' }}>
                <div className="loader"></div>
              </div>
            ) : instrumentAlertError ? (
              <p style={{ margin: 0, color: 'var(--danger)', fontFamily: "'JetBrains Mono', monospace", fontSize: '0.85rem' }}>
                Alert unavailable: {instrumentAlertError}
              </p>
            ) : !instrumentAlert?.alert ? (
              <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                {instrumentAlert?.reason || 'No actionable signals on the latest bar.'}
              </p>
            ) : (
              <AlertRow
                stock={instrumentAlert.alert}
                showHoldingsFields={false}
                onOpenConviction={() => setConvictionStock(instrumentAlert.alert)}
                onOpenTradePlan={() => setTradePlanStock(instrumentAlert.alert)}
              />
            )}
          </section>

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
        // Quarterly ↔ Yearly toggle. Both come from the same screener page;
        // yearly rows live under a different parser (`years`, FY-labelled).
        const isYearly = resultPeriod === 'yearly';
        const activeData = isYearly ? screenerAnnual : screenerQuarterly;
        const activeRows = isYearly ? activeData?.years : activeData?.quarters;
        const activeError = isYearly ? screenerAnnualError : screenerError;
        const periodNoun = isYearly ? 'years' : 'quarters';
        // Yearly gets a slightly longer window (5 FYs) than quarterly (4 Qs).
        const windowSize = isYearly ? 5 : 4;

        const isReady = Array.isArray(activeRows);
        const quarters = isReady ? [...activeRows].sort((a, b) => a.sortKey - b.sortKey) : [];

        const labelFromQFy = (q, fy) => `Q${q} FY${String(fy).slice(-2)}`;

        // Build label → row and label → index maps. Screener rows carry their
        // own label (e.g. "Q3 FY26" or "FY26").
        const byLabel = {};
        const idxByLabel = {};
        quarters.forEach((row, i) => { byLabel[row.label] = row; idxByLabel[row.label] = i; });

        // Primary growth comparison base for a given period column:
        //  • quarterly → same quarter, previous year (handles gaps via label lookup)
        //  • yearly    → the immediately preceding fiscal year (prior column)
        const yoyBaseOf = (period) => {
          if (!period) return null;
          if (isYearly) {
            const i = idxByLabel[period.label];
            return (i != null && i > 0) ? quarters[i - 1] : null;
          }
          return byLabel[labelFromQFy(period.q, period.fy - 1)] || null;
        };

        // Visible window — the most recent `windowSize` periods screener reports.
        // YoY lookups below reach outside this window via byLabel/idxByLabel, so
        // sparse history elsewhere stays handled.
        const columns = quarters.slice(-windowSize);

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
        // Expenses use inverted polarity — rising is bad, falling is good.
        // Expense pill uses sign + colour (no arrow). Rising expenses are bad,
        // and an upward arrow next to a red number reads as a contradiction
        // because every other row treats ↑ as good. Sign carries direction,
        // colour carries sentiment — no visual conflict.
        const expensePill = (curr, prev) => {
          const p = growthPill(curr, prev);
          if (!p) return null;
          const rising = p.label.startsWith('↑');
          const abs = parseFloat(p.label.slice(1));
          let color;
          if (abs < 5)        color = rising ? '#fca5a5' : '#34d399';
          else if (abs < 15)  color = rising ? '#ef4444' : '#10b981';
          else                color = rising ? '#dc2626' : '#059669';
          return { ...p, label: `${rising ? '+' : '−'}${abs.toFixed(1)}%`, color };
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
          { key: 'totalIncome',     label: 'Sales',            fmt: fmtCr,  get: r => r?.totalIncome,     pill: growthPill },
          { key: 'expenses',        label: 'Expenses',         fmt: fmtCr,  get: r => r?.expenses,        pill: expensePill },
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
        const Sparkline = ({ points, invert = false }) => {
          const valid = points.filter(p => p.v != null);
          if (valid.length < 2) {
            return <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>—</span>;
          }
          const last = valid[valid.length - 1].v;
          const first = valid[0].v;
          const rising = last >= first;
          const good = invert ? !rising : rising;
          const color = good ? '#10b981' : '#ef4444';
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

        // ── Quarterly Snapshot — auto-generated trend insights ─────────
        // Programmatic summary (no LLM): YoY hit-rate, margin trajectory,
        // profit direction, and any cautionary flags derived from the last
        // 4–8 quarters of screener data.
        const snapshot = (() => {
          if (quarters.length < 2) return null;
          const last4 = quarters.slice(-windowSize);
          const prev4 = quarters.slice(-2 * windowSize, -windowSize);

          // YoY hit-rate for sales over the visible window
          let salesYoYWins = 0, salesYoYConsidered = 0, latestSalesYoY = null;
          last4.forEach((q, i) => {
            const py = yoyBaseOf(q);
            if (py && py.totalIncome != null && q.totalIncome != null && py.totalIncome !== 0) {
              salesYoYConsidered += 1;
              const pct = ((q.totalIncome - py.totalIncome) / Math.abs(py.totalIncome)) * 100;
              if (pct > 0) salesYoYWins += 1;
              if (i === last4.length - 1) latestSalesYoY = pct;
            }
          });

          // OPM trajectory — two distinct comparisons kept separate:
          //  • card → latest quarter's OPM vs the trailing-4Q average, so the
          //           headline value matches the latest column in the grid below
          //           (component sync) instead of showing the 4Q mean itself.
          //  • flag → trailing-4Q average vs prior-4Q average (a smoother
          //           TTM-vs-TTM signal) used only for the compression warning.
          const avg = (arr) => {
            const v = arr.filter(x => x != null);
            return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
          };
          const opm4qAvg = avg(last4.map(opMarginOf));
          const opmPrev4qAvg = avg(prev4.map(opMarginOf));
          const opmTtmDelta = (opm4qAvg != null && opmPrev4qAvg != null) ? opm4qAvg - opmPrev4qAvg : null;
          const latestOpm = opMarginOf(last4[last4.length - 1]);
          const opmCardDelta = (latestOpm != null && opm4qAvg != null) ? latestOpm - opm4qAvg : null;

          // Net Profit YoY hit-rate + latest YoY
          let npYoYWins = 0, npYoYConsidered = 0, latestNpYoY = null;
          last4.forEach((q, i) => {
            const py = yoyBaseOf(q);
            if (py && py.netProfit != null && q.netProfit != null && py.netProfit !== 0) {
              npYoYConsidered += 1;
              const pct = ((q.netProfit - py.netProfit) / Math.abs(py.netProfit)) * 100;
              if (pct > 0) npYoYWins += 1;
              if (i === last4.length - 1) latestNpYoY = pct;
            }
          });

          // Cautionary flags
          const flags = [];
          // Two consecutive YoY revenue declines
          if (last4.length >= 2) {
            const tail = last4.slice(-2);
            const declines = tail.filter(q => {
              const py = yoyBaseOf(q);
              return py && py.totalIncome != null && q.totalIncome != null && q.totalIncome < py.totalIncome;
            }).length;
            if (declines === 2) flags.push(`Revenue declined YoY in the last 2 ${periodNoun}`);
          }
          // Margin compression > 3pp (trailing-window avg vs prior-window avg)
          if (opmTtmDelta != null && opmTtmDelta < -3) {
            flags.push(`Operating margin compressed by ${Math.abs(opmTtmDelta).toFixed(1)}pp vs prior ${windowSize} ${periodNoun}`);
          }
          // Net loss in latest period
          const latest = last4[last4.length - 1];
          if (latest?.netProfit != null && latest.netProfit < 0) {
            flags.push(`Net loss of ₹${Math.abs(latest.netProfit).toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr in ${latest.label}`);
          }
          // Sharp interest-cost rise (>30% YoY) — debt-service signal
          if (latest?.interest != null) {
            const py = yoyBaseOf(latest);
            if (py?.interest != null && py.interest > 0) {
              const intYoY = ((latest.interest - py.interest) / Math.abs(py.interest)) * 100;
              if (intYoY > 30) flags.push(`Interest cost up ${intYoY.toFixed(0)}% YoY in ${latest.label}`);
            }
          }
          // EPS integrity — the implied share count (net profit ÷ EPS) should be
          // roughly stable quarter to quarter. A sharp jump usually means a
          // split/bonus changed the equity base, which screener's as-reported
          // EPS row may not retro-adjust — distorting the EPS trendline/sparkline.
          // We have no corporate-actions feed, so we DETECT and caveat rather than
          // silently restate (fabricating an adjustment factor would be worse).
          const impliedShares = (row) => {
            if (!row || row.eps == null || row.eps === 0 || row.netProfit == null) return null;
            return (row.netProfit * 1e7) / row.eps; // netProfit ₹Cr, eps ₹/share
          };
          const shareCounts = last4.map(impliedShares).filter(x => x != null && x > 0);
          if (shareCounts.length >= 2) {
            const maxSh = Math.max(...shareCounts);
            const minSh = Math.min(...shareCounts);
            if (maxSh / minSh > 1.2) {
              flags.push(`EPS may not be split/bonus-adjusted across these ${periodNoun} — the implied share base shifted; verify the EPS trend against exchange filings`);
            }
          }

          return {
            salesYoY: { wins: salesYoYWins, considered: salesYoYConsidered, latest: latestSalesYoY },
            opm: { latest: latestOpm, avg4q: opm4qAvg, prevAvg4q: opmPrev4qAvg, cardDelta: opmCardDelta, ttmDelta: opmTtmDelta },
            np: { wins: npYoYWins, considered: npYoYConsidered, latest: latestNpYoY },
            flags,
            latestLabel: latest?.label,
          };
        })();

        // Visual helpers for the snapshot cards
        const trendColor = (v, neutralBand = 0) => {
          if (v == null) return 'var(--text-secondary)';
          if (Math.abs(v) <= neutralBand) return 'var(--text-secondary)';
          return v > 0 ? '#10b981' : '#ef4444';
        };
        const arrow = (v, neutralBand = 0) => {
          if (v == null) return '·';
          if (Math.abs(v) <= neutralBand) return '→';
          return v > 0 ? '↑' : '↓';
        };

        return (
          <section className="glass-panel" style={{ marginTop: '1rem', padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.75rem' }}>
              <div>
                <h2 style={{ margin: 0 }}>{isYearly ? 'Annual Results' : 'Quarterly Results'}</h2>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  {isYearly
                    ? `Last ${windowSize} fiscal years · YoY · Screener.in (standalone)`
                    : `Last ${windowSize} consecutive quarters · YoY · QoQ · Screener.in (standalone)`}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                {/* Quarterly ↔ Yearly toggle */}
                <div role="tablist" aria-label="Results period" style={{ display: 'inline-flex', borderRadius: '8px', border: '1px solid var(--border)', overflow: 'hidden' }}>
                  {[['quarterly', 'Quarterly'], ['yearly', 'Yearly']].map(([key, label]) => {
                    const active = resultPeriod === key;
                    return (
                      <button
                        key={key}
                        role="tab"
                        aria-selected={active}
                        onClick={() => setResultPeriod(key)}
                        style={{
                          background: active ? 'var(--accent)' : 'transparent',
                          color: active ? '#04141f' : 'var(--text-secondary)',
                          border: 'none',
                          padding: '0.35rem 0.9rem',
                          cursor: 'pointer',
                          fontSize: '0.78rem',
                          fontWeight: active ? 700 : 500,
                          transition: 'all 0.15s',
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                {columns.length > 0 && (
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    {columns[0].label} → {columns[columns.length - 1].label}
                  </span>
                )}
              </div>
            </div>

            {snapshot && (
              <div style={{
                marginBottom: '1.25rem',
                padding: '1rem 1.1rem',
                borderRadius: '10px',
                background: 'rgba(56,189,248,0.04)',
                border: '1px solid rgba(56,189,248,0.18)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    {isYearly ? 'Annual Snapshot' : 'Quarterly Snapshot'}
                  </span>
                  {snapshot.latestLabel && (
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                      · latest {snapshot.latestLabel}
                    </span>
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem' }}>
                  {/* Sales trend */}
                  <div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Sales YoY</div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 700, color: trendColor(snapshot.salesYoY.latest), marginTop: '0.2rem' }}>
                      {arrow(snapshot.salesYoY.latest)} {snapshot.salesYoY.latest == null ? '—' : `${snapshot.salesYoY.latest >= 0 ? '+' : ''}${snapshot.salesYoY.latest.toFixed(1)}%`}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                      {snapshot.salesYoY.considered > 0
                        ? `Grew in ${snapshot.salesYoY.wins} of last ${snapshot.salesYoY.considered} ${periodNoun}`
                        : 'Insufficient YoY history'}
                    </div>
                  </div>

                  {/* Operating margin trajectory */}
                  <div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>OPM Trajectory</div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 700, color: trendColor(snapshot.opm.cardDelta, 0.5), marginTop: '0.2rem' }}>
                      {arrow(snapshot.opm.cardDelta, 0.5)} {snapshot.opm.cardDelta == null ? '—' : `${snapshot.opm.cardDelta >= 0 ? '+' : ''}${snapshot.opm.cardDelta.toFixed(1)} pp`}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                      {snapshot.opm.latest != null && snapshot.opm.avg4q != null
                        ? `${snapshot.opm.latest.toFixed(1)}% latest vs ${snapshot.opm.avg4q.toFixed(1)}% (${windowSize}${isYearly ? 'Y' : 'Q'} avg)`
                        : `Needs ≥ ${windowSize} ${periodNoun}`}
                    </div>
                  </div>

                  {/* Net Profit trend */}
                  <div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Net Profit YoY</div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 700, color: trendColor(snapshot.np.latest), marginTop: '0.2rem' }}>
                      {arrow(snapshot.np.latest)} {snapshot.np.latest == null ? '—' : `${snapshot.np.latest >= 0 ? '+' : ''}${snapshot.np.latest.toFixed(1)}%`}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                      {snapshot.np.considered > 0
                        ? `Grew in ${snapshot.np.wins} of last ${snapshot.np.considered} ${periodNoun}`
                        : 'Insufficient YoY history'}
                    </div>
                  </div>
                </div>

                {snapshot.flags.length > 0 && (
                  <div style={{ marginTop: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                    {snapshot.flags.map((f, i) => (
                      <div key={i} style={{
                        fontSize: '0.75rem',
                        color: '#fca5a5',
                        background: 'rgba(239,68,68,0.08)',
                        border: '1px solid rgba(239,68,68,0.22)',
                        padding: '0.3rem 0.55rem',
                        borderRadius: '6px',
                      }}>
                        ⚠ {f}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {!isReady || columns.length === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--text-secondary)', marginTop: '1.5rem' }}>
                {activeError
                  ? `Screener.in data unavailable: ${activeError}`
                  : activeData == null
                    ? 'Loading from Screener.in…'
                    : `${isYearly ? 'Annual' : 'Quarterly'} comparison data is not available for this instrument.`}
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
                            // QoQ → prior column in the visible window (quarterly only)
                            const qoqCol = idx > 0 ? columns[idx - 1] : null;
                            const qoqValue = qoqCol ? row.get(byLabel[qoqCol.label]) : undefined;
                            // YoY → quarterly: same quarter previous year; yearly:
                            // the preceding fiscal year. Looked up regardless of visibility.
                            const yoyValue = row.get(yoyBaseOf(col));
                            const yoyPill = row.pill(value, yoyValue);
                            // Yearly's YoY already IS the sequential change, so the
                            // QoQ pill is dropped to avoid a redundant second figure.
                            const qoqPill = (!isYearly && qoqValue !== undefined) ? row.pill(value, qoqValue) : null;

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
                                  {!isYearly && (qoqPill ? (
                                    <span title="Quarter-on-Quarter" style={{ color: qoqPill.color, fontWeight: qoqPill.weight }}>
                                      <span style={{ color: 'var(--text-secondary)', fontWeight: 500, marginRight: '3px' }}>QoQ</span>
                                      {qoqPill.label}
                                    </span>
                                  ) : (
                                    idx > 0 && <span style={{ color: 'var(--text-secondary)' }}>QoQ —</span>
                                  ))}
                                </div>
                              </td>
                            );
                          })}
                          <td style={{ textAlign: 'right', padding: '0.85rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <div style={{ display: 'inline-block' }}>
                              <Sparkline points={sparkPoints} invert={row.key === 'expenses'} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ marginTop: '0.75rem', fontSize: '0.7rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                  Source: screener.in (standalone, ₹ Cr). Operating Margin uses percentage-point change. {isYearly ? 'Annual figures show completed fiscal years (TTM column excluded).' : ''} Results refresh once every 12 hours.
                </div>
              </div>
            )}
          </section>
        );
      })()}

      {activeTab === 'cashflow' && (() => {
        // ── Annual cashflow chart — screener.in-backed ──────────────────
        // Indian companies don't file quarterly cashflow statements (standalone),
        // so the previous quarterly toggle was being fed Yahoo-derived numbers
        // of dubious accuracy. Switched to screener's annual cashflow which
        // gives us up to 12 fiscal years with CFO/CFI/CFF and pre-computed FCF.
        const years = Array.isArray(screenerCashflow?.years) ? screenerCashflow.years : [];
        // Show most-recent 8 years (chart gets unreadable past that).
        const visible = years.slice(-8);

        return (
          <section className="glass-panel" style={{ marginTop: '1rem', height: '500px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div>
                <h2 style={{ margin: 0 }}>Cashflow Analysis</h2>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  Annual cashflow statement · Screener.in (standalone, ₹ Cr)
                </span>
              </div>
              {visible.length > 0 && (
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {visible[0].fyLabel} → {visible[visible.length - 1].fyLabel}
                </span>
              )}
            </div>

            {visible.length === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                {screenerCashflowError
                  ? `Cashflow unavailable: ${screenerCashflowError}`
                  : screenerCashflow == null ? 'Loading from Screener.in…' : 'Cashflow data is not available for this instrument.'}
              </p>
            ) : (
              <div style={{ flex: 1, minHeight: 0 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={visible} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="fyLabel" stroke="var(--text-secondary)" />
                    <YAxis
                      stroke="var(--text-secondary)"
                      tickFormatter={(val) => `₹${val.toLocaleString('en-IN', { maximumFractionDigits: 0 })}Cr`}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: 'var(--bg-dark)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                      formatter={(value, name) => [
                        value == null ? '—' : `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`,
                        name,
                      ]}
                      labelFormatter={(label) => `Fiscal Year ${label}`}
                    />
                    <Legend />
                    <Bar dataKey="operatingCashFlow"  name="Operating (CFO)"  fill="var(--accent)" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="investingCashFlow"  name="Investing (CFI)"  fill="#a29bfe"       radius={[4, 4, 0, 0]} />
                    <Bar dataKey="financingCashFlow"  name="Financing (CFF)"  fill="var(--danger)" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="freeCashFlow"       name="Free Cash Flow"   fill="var(--success)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>
        );
      })()}

      {activeTab === 'balanceSheet' && (() => {
        // ── Annual balance sheet — screener.in-backed (consolidated) ────
        // Server defaults to /company/<SLUG>/consolidated/ and falls back to
        // standalone when consolidated is missing. Latest year is rightmost
        // so the eye reads left → right as oldest → newest.
        const years = Array.isArray(screenerBalanceSheet?.years)
          ? [...screenerBalanceSheet.years].sort((a, b) => a.sortKey - b.sortKey)
          : [];
        const basis = screenerBalanceSheet?.basis;

        // Rows to display in order. Each row is { key, label, group } where
        // group is 'liab' / 'asset' / 'derived' for sectioning.
        const ROWS = [
          { key: 'equityCapital',     label: 'Equity Capital',     group: 'liab' },
          { key: 'reserves',          label: 'Reserves',           group: 'liab' },
          { key: 'netWorth',          label: 'Net Worth',          group: 'liab', emphasis: true },
          { key: 'borrowings',        label: 'Borrowings',         group: 'liab' },
          { key: 'deposits',          label: 'Deposits',           group: 'liab' },
          { key: 'otherLiabilities',  label: 'Other Liabilities',  group: 'liab' },
          { key: 'totalLiabilities',  label: 'Total Equity & Liabilities',  group: 'liab', emphasis: true },
          { key: 'fixedAssets',       label: 'Fixed Assets',       group: 'asset' },
          { key: 'cwip',              label: 'CWIP',               group: 'asset' },
          { key: 'investments',       label: 'Investments',        group: 'asset' },
          { key: 'loans',             label: 'Loans',              group: 'asset' },
          { key: 'otherAssets',       label: 'Other Assets',       group: 'asset' },
          { key: 'totalAssets',       label: 'Total Assets',       group: 'asset', emphasis: true },
        ];

        const hasAnyValue = (key) => years.some(y => y[key] != null);
        const visibleRows = ROWS.filter(r => hasAnyValue(r.key));

        const fmt = (v) => v == null
          ? <span style={{ color: 'var(--text-secondary)' }}>—</span>
          : v.toLocaleString('en-IN', { maximumFractionDigits: 0 });

        // YoY % change vs prior column. Shown as a small badge under the value
        // for emphasised rows (Net Worth, Total Liabilities, Total Assets).
        const yoy = (curr, prev) => {
          if (curr == null || prev == null || prev === 0) return null;
          return ((curr - prev) / Math.abs(prev)) * 100;
        };

        // ── Balance Sheet Snapshot — programmatic insights ─────────────
        // Derives leverage, capital-structure trend, capex signal, and any
        // cautionary flags from the multi-year series. No LLM, just arithmetic
        // over the parsed numbers so the conclusions match the visible data.
        const bsSnapshot = (() => {
          if (years.length < 2) return null;
          const latest = years[years.length - 1];
          const prior = years[years.length - 2];
          const earliest = years[0];

          // Leverage: prefer borrowings (corp) but fall back to deposits (bank)
          const debtField = latest.borrowings != null ? 'borrowings' : (latest.deposits != null ? 'deposits' : null);
          const debt = debtField ? latest[debtField] : null;
          const debtPrior = debtField ? prior[debtField] : null;

          const de = (debt != null && latest.netWorth != null && latest.netWorth !== 0)
            ? debt / latest.netWorth
            : null;
          const debtYoY = (debt != null && debtPrior != null && debtPrior !== 0)
            ? ((debt - debtPrior) / Math.abs(debtPrior)) * 100
            : null;

          // Net Worth CAGR over the visible range. Both endpoints must be
          // positive — CAGR is undefined when net worth crosses zero (you
          // can't compound from positive into negative), and Math.pow() of a
          // negative ratio to a fractional power returns NaN. The Vodafone
          // Idea case (₹23k Cr → -₹35k Cr) triggered exactly this. Caller
          // surfaces a "Turned negative" hint below when this returns null.
          const nwCAGR = (() => {
            if (latest.netWorth == null || earliest.netWorth == null) return null;
            if (earliest.netWorth <= 0 || latest.netWorth <= 0) return null;
            const yrs = latest.fy - earliest.fy;
            if (yrs <= 0) return null;
            return (Math.pow(latest.netWorth / earliest.netWorth, 1 / yrs) - 1) * 100;
          })();
          const nwTurnedNegative = (
            earliest.netWorth != null && latest.netWorth != null
            && earliest.netWorth > 0 && latest.netWorth <= 0
          );

          // Total Assets YoY (latest)
          const assetsYoY = (latest.totalAssets != null && prior.totalAssets != null && prior.totalAssets !== 0)
            ? ((latest.totalAssets - prior.totalAssets) / Math.abs(prior.totalAssets)) * 100
            : null;

          // CWIP YoY — large jumps signal an active capex cycle
          const cwipYoY = (latest.cwip != null && prior.cwip != null && prior.cwip > 0)
            ? ((latest.cwip - prior.cwip) / Math.abs(prior.cwip)) * 100
            : null;

          // ── Cautionary flags ─────────────────────────────────────────
          const flags = [];
          if (latest.netWorth != null && latest.netWorth < 0) {
            flags.push(`Negative net worth of ₹${Math.abs(latest.netWorth).toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr — solvency risk`);
          }
          if (de != null && de > 2) {
            flags.push(`High leverage — D/E of ${de.toFixed(2)}× (debt ₹${debt.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr vs net worth ₹${latest.netWorth.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr)`);
          }
          if (debtYoY != null && debtYoY > 30) {
            flags.push(`${debtField === 'borrowings' ? 'Borrowings' : 'Deposits'} jumped +${debtYoY.toFixed(0)}% in ${latest.fyLabel}`);
          }
          // Net worth declining for 2+ consecutive years
          if (years.length >= 3) {
            const a = years[years.length - 3].netWorth;
            const b = prior.netWorth;
            const c = latest.netWorth;
            if (a != null && b != null && c != null && c < b && b < a) {
              flags.push(`Net worth declining for 2+ consecutive years (${years[years.length - 3].fyLabel} → ${latest.fyLabel})`);
            }
          }
          if (cwipYoY != null && cwipYoY > 100) {
            flags.push(`CWIP ballooned +${cwipYoY.toFixed(0)}% — large capex cycle in progress, watch for execution risk`);
          }

          return { latest, debtField, debt, de, debtYoY, nwCAGR, nwTurnedNegative, assetsYoY, cwipYoY, flags };
        })();

        const trendColor = (v, band = 0) => {
          if (v == null) return 'var(--text-secondary)';
          if (Math.abs(v) <= band) return 'var(--text-secondary)';
          return v > 0 ? '#10b981' : '#ef4444';
        };
        const arrow = (v, band = 0) => {
          if (v == null) return '·';
          if (Math.abs(v) <= band) return '→';
          return v > 0 ? '↑' : '↓';
        };

        return (
          <section className="glass-panel" style={{ marginTop: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div>
                <h2 style={{ margin: 0 }}>Balance Sheet</h2>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  Annual · Screener.in{basis ? ` (${basis}` : ''}{basis ? ', ₹ Cr)' : ' (₹ Cr)'}
                </span>
              </div>
              {years.length > 0 && (
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {years[0].fyLabel} → {years[years.length - 1].fyLabel}
                </span>
              )}
            </div>

            {years.length === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                {screenerBalanceSheetError
                  ? `Balance sheet unavailable: ${screenerBalanceSheetError}`
                  : screenerBalanceSheet == null ? 'Loading from Screener.in…' : 'Balance sheet data is not available for this instrument.'}
              </p>
            ) : (
              <>
                {bsSnapshot && (
                  <div style={{
                    marginBottom: '1.25rem',
                    padding: '1rem 1.1rem',
                    borderRadius: '10px',
                    background: 'rgba(56,189,248,0.04)',
                    border: '1px solid rgba(56,189,248,0.18)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                      <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        Balance Sheet Snapshot
                      </span>
                      {bsSnapshot.latest?.fyLabel && (
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                          · latest {bsSnapshot.latest.fyLabel}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem' }}>
                      {/* Leverage */}
                      <div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Debt-to-Equity</div>
                        <div style={{
                          fontSize: '1.05rem', fontWeight: 700, marginTop: '0.2rem',
                          color: bsSnapshot.de == null ? 'var(--text-secondary)'
                            : bsSnapshot.de > 2 ? '#ef4444'
                            : bsSnapshot.de > 1 ? '#f59e0b'
                            : '#10b981',
                        }}>
                          {bsSnapshot.de == null ? '—' : `${bsSnapshot.de.toFixed(2)}×`}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                          {bsSnapshot.debt != null && bsSnapshot.latest.netWorth != null
                            ? `₹${bsSnapshot.debt.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr ${bsSnapshot.debtField === 'borrowings' ? 'debt' : 'deposits'} / ₹${bsSnapshot.latest.netWorth.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr net worth`
                            : 'Insufficient data'}
                        </div>
                      </div>

                      {/* Net Worth CAGR */}
                      <div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Net Worth CAGR</div>
                        <div style={{
                          fontSize: '1.05rem', fontWeight: 700, marginTop: '0.2rem',
                          color: bsSnapshot.nwTurnedNegative ? '#ef4444' : trendColor(bsSnapshot.nwCAGR, 0.5),
                        }}>
                          {bsSnapshot.nwTurnedNegative
                            ? '↓ n/a'
                            : bsSnapshot.nwCAGR == null
                              ? '—'
                              : `${arrow(bsSnapshot.nwCAGR, 0.5)} ${bsSnapshot.nwCAGR >= 0 ? '+' : ''}${bsSnapshot.nwCAGR.toFixed(1)}% /yr`}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                          {bsSnapshot.nwTurnedNegative
                            ? `Turned negative by ${bsSnapshot.latest.fyLabel}`
                            : bsSnapshot.nwCAGR != null
                              ? `${years[0].fyLabel} → ${bsSnapshot.latest.fyLabel}`
                              : 'Needs ≥ 2 years'}
                        </div>
                      </div>

                      {/* Debt trend */}
                      <div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{bsSnapshot.debtField === 'deposits' ? 'Deposits' : 'Debt'} YoY</div>
                        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: trendColor(bsSnapshot.debtYoY == null ? null : -bsSnapshot.debtYoY, 2), marginTop: '0.2rem' }}>
                          {arrow(bsSnapshot.debtYoY, 0)} {bsSnapshot.debtYoY == null ? '—' : `${bsSnapshot.debtYoY >= 0 ? '+' : ''}${bsSnapshot.debtYoY.toFixed(1)}%`}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                          {bsSnapshot.debtYoY == null
                            ? 'Insufficient data'
                            : bsSnapshot.debtYoY > 0 ? 'Adding leverage' : 'Deleveraging'}
                        </div>
                      </div>

                      {/* Total Assets growth */}
                      <div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Total Assets YoY</div>
                        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: trendColor(bsSnapshot.assetsYoY, 0.5), marginTop: '0.2rem' }}>
                          {arrow(bsSnapshot.assetsYoY, 0.5)} {bsSnapshot.assetsYoY == null ? '—' : `${bsSnapshot.assetsYoY >= 0 ? '+' : ''}${bsSnapshot.assetsYoY.toFixed(1)}%`}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                          {bsSnapshot.cwipYoY != null && Math.abs(bsSnapshot.cwipYoY) > 10
                            ? `CWIP ${bsSnapshot.cwipYoY >= 0 ? '+' : ''}${bsSnapshot.cwipYoY.toFixed(0)}% — capex signal`
                            : 'Balance sheet expansion'}
                        </div>
                      </div>
                    </div>

                    {bsSnapshot.flags.length > 0 && (
                      <div style={{ marginTop: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                        {bsSnapshot.flags.map((f, i) => (
                          <div key={i} style={{
                            fontSize: '0.75rem',
                            color: '#fca5a5',
                            background: 'rgba(239,68,68,0.08)',
                            border: '1px solid rgba(239,68,68,0.22)',
                            padding: '0.3rem 0.55rem',
                            borderRadius: '6px',
                          }}>
                            ⚠ {f}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

              <div style={{ overflowX: 'auto' }}>
                <table className="interactive-table" style={{ minWidth: '100%' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', position: 'sticky', left: 0, background: 'var(--bg-card)', zIndex: 1 }}>Metric</th>
                      {years.map(y => (
                        <th key={y.sortKey} style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{y.fyLabel}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map(row => (
                      <tr key={row.key} style={row.emphasis ? { background: 'rgba(56,189,248,0.04)', fontWeight: 700 } : undefined}>
                        <td style={{ position: 'sticky', left: 0, background: row.emphasis ? 'rgba(56,189,248,0.04)' : 'var(--bg-card)', zIndex: 1, fontWeight: row.emphasis ? 700 : 500 }}>
                          {row.label}
                        </td>
                        {years.map((y, i) => {
                          const v = y[row.key];
                          const prev = i > 0 ? years[i - 1][row.key] : null;
                          const delta = row.emphasis ? yoy(v, prev) : null;
                          return (
                            <td key={y.sortKey} style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                              <div>{fmt(v)}</div>
                              {delta != null && (
                                <div className={delta >= 0 ? 'positive' : 'negative'} style={{ fontSize: '0.7rem', fontWeight: 500 }}>
                                  {delta >= 0 ? '+' : ''}{delta.toFixed(1)}%
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.75rem', marginBottom: 0 }}>
                  Net Worth = Equity Capital + Reserves. Total Equity &amp; Liabilities always equals Total Assets — that's the accounting identity, not a bug. Banks/NBFCs may report Deposits and Loans instead of Borrowings. Empty cells (—) mean the field wasn't disclosed for that year.
                </p>
              </div>
              </>
            )}
          </section>
        );
      })()}

      {activeTab === 'shareholding' && (
        <ShareholdingPanel
          payload={screenerShareholding}
          error={screenerShareholdingError}
        />
      )}

      <ConvictionModal stock={convictionStock} onClose={() => setConvictionStock(null)} />
      <TradePlanModal stock={tradePlanStock} onClose={() => setTradePlanStock(null)} />
    </div>
  )
}

export default Instrument
