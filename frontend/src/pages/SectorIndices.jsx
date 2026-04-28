import { useState, useEffect, useRef, memo, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Cell as RechartsCell, ResponsiveContainer } from 'recharts';
import RRGChart from '../components/RRGChart';
import { fetchWithAbort } from '../hooks/useFetchWithAbort';

// ─── RRG Color Palette ─────────────────────────────────────────
const RRG_COLORS = [
  '#00bcd4', '#ff6384', '#36a2eb', '#ffce56', '#4bc0c0',
  '#9966ff', '#ff9f40', '#e7e9ed', '#22c55e', '#f87171',
  '#a78bfa', '#fb923c', '#38bdf8', '#facc15', '#34d399',
  '#f472b6', '#818cf8'
];

// ─── Tunable constants ────────────────────────────────────────
// Momentum score component weights. Must sum to 1.0. 1M is weighted heaviest
// because it best reflects current trend while 1W catches breakouts and 3M
// trims noise.
const W_1W = 0.20, W_1M = 0.50, W_3M = 0.30;

// RSI multipliers applied to the raw weighted return before percentile ranking.
// Penalize overbought (stretched) sectors, boost oversold (rebound candidates).
const RSI_MULT_SEVERE_OVERBOUGHT = 0.85;
const RSI_MULT_OVERBOUGHT = 0.92;
const RSI_MULT_OVERSOLD = 1.08;
const RSI_MULT_SEVERE_OVERSOLD = 1.15;

// Refresh intervals (ms)
const QUOTES_REFRESH_MS = 60_000;   // Live prices / 1D change
const RRG_REFRESH_MS = 5 * 60_000;  // RRG is weekly data, 5 min is ample
const RRG_POLL_MS = 10_000;         // Warm-up poll while cache hydrates
const RRG_MAX_WARMUP_POLLS = 18;    // Give up after ~3 minutes

// Delay between serial history fetches (rate-limit headroom). Skipped on cache hits.
const HIST_FETCH_DELAY_MS = 1500;
const HIST_CACHE_DELAY_MS = 50;

// Benchmarks the RRG/RS columns can be evaluated against. Loaded regardless of
// which tab is active so "RS vs <benchmark>" is populated on first render.
const RRG_BENCHMARK_KEYS = new Set(["NSE:NIFTY 50", "NSE:NIFTY 500", "NSE:NIFTY MIDCAP 100"]);

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
  { key: "NSE:NIFTY PVT BANK", name: "NIFTY PRIVATE BANK", category: "sector" },
  { key: "NSE:NIFTY CONSR DURBL", name: "NIFTY CONSUMER DURABLES", category: "sector" },
  { key: "NSE:NIFTY HEALTHCARE", name: "NIFTY HEALTHCARE", category: "sector" },
  { key: "NSE:NIFTY MEDIA", name: "NIFTY MEDIA", category: "sector" },
  { key: "NSE:NIFTY COMMODITIES", name: "NIFTY COMMODITIES", category: "sector" },
  { key: "NSE:NIFTY CHEMICALS", name: "NIFTY CHEMICALS", category: "sector" },
  { key: "NSE:NIFTY OIL AND GAS", name: "NIFTY OIL AND GAS", category: "sector" },
  { key: "NSE:NIFTY IND DEFENCE", name: "NIFTY INDIA DEFENCE", category: "sector" },
];

// Empty placeholder row so unloaded-tab indices still render in the table.
const emptyRowFor = (entry) => ({
  id: entry.key, name: entry.name, category: entry.category, token: null,
  price: 0, '1D': null,
  '1W': null, '1M': null, '3M': null, '6M': null, '1Y': null, '3Y': null, '5Y': null,
  sparkline: null, aboveSma50: null, rsi14: null, dist52WHigh: null, rs1M: null,
});

function SectorIndices() {
  const navigate = useNavigate();
  const [data, setData] = useState(() => INDICES.map(emptyRowFor));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('sector');
  // Tabs whose quote/history fetches have been kicked off. Broad Market is
  // deferred until the user opens that tab so the initial Sector view loads fast.
  const [loadedTabs, setLoadedTabs] = useState(() => new Set(['sector']));
  const historyLoadedRef = useRef(new Set());
  const [isHeatmap, setIsHeatmap] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [hiddenColumns, setHiddenColumns] = useState({ '1W': false, '6M': false, '3Y': false, '5Y': false });
  const [showColumnMenu, setShowColumnMenu] = useState(false);
  const [momentumPopover, setMomentumPopover] = useState(null); // { rowId, x, y }
  const searchInputRef = useRef(null);

  // Sorting state
  const [sortConfig, setSortConfig] = useState({ key: 'name', direction: 'asc' });

  // ─── RRG State ─────────────────────────────────────────────
  const [rrg, setRrg] = useState(null);
  const [rrgBenchmark, setRrgBenchmark] = useState("NSE:NIFTY 50");
  const [rrgLoading, setRrgLoading] = useState(false);
  const [rrgTailLength, setRrgTailLength] = useState(7);
  const [activeSignalModal, setActiveSignalModal] = useState(null);
  const [rrgHidden, setRrgHidden] = useState({});
  const [rrgAnimating, setRrgAnimating] = useState(false);
  const [rrgAnimFrame, setRrgAnimFrame] = useState(0);
  const [rrgScrubEnd, setRrgScrubEnd] = useState(null); // null = latest
  const rrgAnimRef = useRef(null);
  const [rrgTooltip, setRrgTooltip] = useState(null);
  const rrgSvgRef = useRef(null);
  const rrgContainerRef = useRef(null);

  // Progressive loading queue refs
  const mountedRef = useRef(true);
  // Top-level abort controller used by long-running progressive loops
  // (loadHistoricalDataProgressively is invoked from inside pullQuotes, so it
  // needs an abort signal that lives across the full mount lifetime).
  const pageAbortRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    pageAbortRef.current = new AbortController();
    return () => {
      mountedRef.current = false;
      pageAbortRef.current?.abort();
    };
  }, []);

  // Cmd/Ctrl+K focuses the search input.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let refreshTimer = null;

    const activeIndices = INDICES.filter(i => loadedTabs.has(i.category) || RRG_BENCHMARK_KEYS.has(i.key));
    if (activeIndices.length === 0) return;
    const activeKeys = activeIndices.map(i => i.key);

    const fireIfVisible = (fn) => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') fn();
    };

    const pullQuotes = async () => {
      try {
        const res = await fetchWithAbort('/api/quotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instruments: activeKeys }),
          signal
        });

        const resData = await res.json();
        if (signal.aborted || !mountedRef.current) return;

        if (resData?.content?.[0]?.text) {
          const quotes = JSON.parse(resData.content[0].text);
          const updates = activeIndices.map(entry => {
            const quote = quotes[entry.key] || {};
            const lastPrice = quote.last_price ?? null;
            const prevClose = quote.ohlc?.close;
            const absChange = quote.net_change !== undefined
              ? quote.net_change
              : (prevClose !== undefined && lastPrice !== null ? lastPrice - prevClose : null);

            const pct1D = (prevClose && absChange !== null && absChange !== undefined)
              ? (absChange / prevClose) * 100
              : null;

            return {
              id: entry.key,
              token: quote.instrument_token,
              price: lastPrice ?? 0,
              '1D': pct1D,
            };
          });

          setData(prev => prev.map(row => {
            const u = updates.find(x => x.id === row.id);
            return u ? { ...row, price: u.price, '1D': u['1D'], token: u.token ?? row.token } : row;
          }));
          setLoading(false);
          setLastUpdated(new Date());

          // Kick off history loading for indices we haven't queued yet.
          const newHistoryQueue = updates
            .filter(u => u.token && !historyLoadedRef.current.has(u.id))
            .map(u => {
              const meta = INDICES.find(i => i.key === u.id);
              return { id: u.id, name: meta?.name || u.id, token: u.token, price: u.price };
            });
          for (const q of newHistoryQueue) historyLoadedRef.current.add(q.id);
          if (newHistoryQueue.length > 0) loadHistoricalDataProgressively(newHistoryQueue);
        } else {
          throw new Error('Failed to parse quotes');
        }
      } catch (err) {
        if (err.name === 'AbortError' || signal.aborted || !mountedRef.current) return;
        if (err.name === 'RateLimitedError') return;
        // Only surface the error on first load (nothing yet has populated).
        if (historyLoadedRef.current.size === 0) {
          console.error(err);
          setError("Failed to load initial benchmark data. Backend might be down.");
          setLoading(false);
        }
        // On refresh failures just swallow — next tick may recover.
      }
    };

    pullQuotes();
    refreshTimer = setInterval(() => fireIfVisible(pullQuotes), QUOTES_REFRESH_MS);
    return () => {
      controller.abort();
      if (refreshTimer) clearInterval(refreshTimer);
    };
  }, [loadedTabs]);

  // ─── RRG Data Fetch ─────────────────────────────────────────
  const fetchRRGData = useCallback(async (signal) => {
    if (!mountedRef.current) return 0;
    try {
      const res = await fetchWithAbort(`/api/rrg?benchmark=${encodeURIComponent(rrgBenchmark)}`, { signal });
      const data = await res.json();
      if (mountedRef.current && data.sectors && data.sectors.length > 0) {
        setRrg(data);
        setRrgLoading(false);
        return data.sectors.length;
      }
    } catch (err) {
      if (err.name === 'AbortError' || (signal && signal.aborted)) return 0;
      if (err.name === 'RateLimitedError') return 0;
      console.error('RRG fetch error:', err);
    }
    return 0;
  }, [rrgBenchmark]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let attempts = 0;
    let warmupTimer = null;
    let refreshTimer = null;

    const fireIfVisible = (fn) => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') fn();
    };

    const pollRRG = async () => {
      if (signal.aborted || !mountedRef.current) return;
      attempts += 1;
      setRrgLoading(true);
      const count = await fetchRRGData(signal);
      if (signal.aborted || !mountedRef.current) return;

      if (count >= 5) {
        // Warm enough — switch to periodic refresh; pause when tab hidden.
        refreshTimer = setInterval(() => fireIfVisible(() => fetchRRGData(signal)), RRG_REFRESH_MS);
        return;
      }
      if (attempts >= RRG_MAX_WARMUP_POLLS) {
        console.warn(`RRG warm-up gave up after ${attempts} polls; backend is only returning ${count} sectors.`);
        // Still set a refresh in case the backend catches up.
        refreshTimer = setInterval(() => fireIfVisible(() => fetchRRGData(signal)), RRG_REFRESH_MS);
        return;
      }
      warmupTimer = setTimeout(pollRRG, RRG_POLL_MS);
    };

    const kickoff = setTimeout(pollRRG, 5000);
    return () => {
      controller.abort();
      clearTimeout(kickoff);
      if (warmupTimer) clearTimeout(warmupTimer);
      if (refreshTimer) clearInterval(refreshTimer);
    };
  }, [fetchRRGData]); // Re-armed when benchmark changes (fetchRRGData identity flips).

  // Re-fetch RRG and reset scrubber when the user changes the benchmark directly.
  useEffect(() => {
    if (rrg) {
      setRrgLoading(true);
      setRrgScrubEnd(null);  // Series length may differ between benchmarks — reset to latest.
      setRrgAnimFrame(0);
      fetchRRGData(pageAbortRef.current?.signal);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rrgBenchmark]);

  const loadHistoricalDataProgressively = async (indicesList) => {
    const signal = pageAbortRef.current?.signal;
    for (let index of indicesList) {
      if (!mountedRef.current || signal?.aborted) break;

      let wasCached = false;
      try {
        // Use the multi-year endpoint that fetches 5Y data in yearly chunks
        const res = await fetchWithAbort(`/api/historical-full/${index.token}`, { signal });
        const resData = await res.json();
        wasCached = !!resData?.cached;

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
        if (e.name === 'AbortError' || signal?.aborted) break;
        if (e.name === 'RateLimitedError') break;
        console.error("Failed history for", index.name, e);
      }

      if (signal?.aborted || !mountedRef.current) break;
      // Only enforce rate-limit spacing when the backend actually hit the upstream.
      await new Promise(r => setTimeout(r, wasCached ? HIST_CACHE_DELAY_MS : HIST_FETCH_DELAY_MS));
    }
    // After all historical data is loaded, do a final RRG refresh to pick up all sectors
    if (mountedRef.current && !signal?.aborted) {
      console.log('Progressive loading complete — refreshing RRG data...');
      fetchRRGData(signal);
    }
  };

  const calculateHistoricalReturns = (series, currentPrice) => {
    // series is already sorted by date ascending.
    // Anchor the "today" reference to midnight IST (Asia/Kolkata) regardless of the
    // host machine's timezone. Using Intl.DateTimeFormat avoids the common bug of
    // double-applying getTimezoneOffset().
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const d = parts.find(p => p.type === 'day').value;
    const nowIST = new Date(`${y}-${m}-${d}T00:00:00Z`); // midnight IST rendered as UTC
    
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

    const target1Y = d1Y.getTime();
    let maxClose52W = currentPrice;
    for (let i = 0; i < series.length; i++) {
      if (dates[i] >= target1Y && series[i].close > maxClose52W) {
        maxClose52W = series[i].close;
      }
    }
    const dist52WHigh = maxClose52W > 0 ? ((currentPrice - maxClose52W) / maxClose52W) * 100 : 0;

    return {
      '1W': calcPct(getPriceAtDate(d1W)),
      '1M': calcPct(getPriceAtDate(d1M)),
      '3M': calcPct(getPriceAtDate(d3M)),
      '6M': calcPct(getPriceAtDate(d6M)),
      '1Y': calcPct(getPriceAtDate(d1Y)),
      '3Y': calcPct(getPriceAtDate(d3Y)),
      '5Y': calcPct(getPriceAtDate(d5Y)),
      dist52WHigh
    };
  };

  const requestSort = (key) => {
    let direction = 'desc';
    if (sortConfig.key === key && sortConfig.direction === 'desc') {
      direction = 'asc';
    }
    setSortConfig({ key, direction });
  };


  // ─── Momentum Score + Market Signal derivation ────────────────
  // Quadrant helper mirrors the backend logic so we can classify historic RRG
  // points (which only carry rsRatio/rsMomentum, not a precomputed quadrant).
  const quadrantOf = (rsRatio, rsMomentum) => {
    if (rsRatio == null || rsMomentum == null) return 'Unknown';
    if (rsRatio >= 100 && rsMomentum >= 100) return 'Leading';
    if (rsRatio >= 100 && rsMomentum < 100)  return 'Weakening';
    if (rsRatio < 100  && rsMomentum >= 100) return 'Improving';
    return 'Lagging';
  };

  const rsiMultiplierFor = (rsi14) => {
    if (rsi14 == null) return 1.0;
    if (rsi14 >= 80) return RSI_MULT_SEVERE_OVERBOUGHT;
    if (rsi14 >= 70) return RSI_MULT_OVERBOUGHT;
    if (rsi14 <= 20) return RSI_MULT_SEVERE_OVERSOLD;
    if (rsi14 <= 30) return RSI_MULT_OVERSOLD;
    return 1.0;
  };

  // Build the enriched rows (momentum score, RRG columns, market signal) using
  // inputs that may legitimately change: the sector data, the active RRG payload,
  // and the selected benchmark (which drives 1M RS).
  const enrichedData = useMemo(() => {
    if (!data || data.length === 0) return [];

    // rs1M compares against the *selected RRG benchmark*, not a hardcoded NIFTY 50.
    const benchmarkRow = data.find(r => r.id === rrgBenchmark);
    const benchmark1M = benchmarkRow ? benchmarkRow['1M'] : null;
    const benchmarkShort = rrgBenchmark.split(':')[1] || rrgBenchmark;

    // Score universe = current tab slice (so scoring stays comparable within a view).
    const tabRows = data.filter(row => activeTab === 'all' || row.category === activeTab);
    const scorable = tabRows.filter(r => r['1W'] !== null && r['1M'] !== null && r['3M'] !== null);

    const breakdownById = {};
    const scoreMap = {};

    if (scorable.length > 0) {
      const rawScores = scorable.map(r => {
        const w1w = (r['1W'] || 0) * W_1W;
        const w1m = (r['1M'] || 0) * W_1M;
        const w3m = (r['3M'] || 0) * W_3M;
        const raw = w1w + w1m + w3m;
        const rsiMult = rsiMultiplierFor(r.rsi14);
        breakdownById[r.id] = { w1w, w1m, w3m, raw, rsiMult, adjusted: raw * rsiMult };
        return { id: r.id, adjusted: raw * rsiMult };
      });
      const sortedRaw = [...rawScores].sort((a, b) => a.adjusted - b.adjusted);
      const n = sortedRaw.length;
      sortedRaw.forEach((s, rank) => {
        scoreMap[s.id] = n === 1 ? 50 : Math.round(1 + (rank / (n - 1)) * 99);
      });
      Object.keys(breakdownById).forEach(id => { breakdownById[id].percentile = scoreMap[id] ?? null; });
    }

    return tabRows.map(r => {
      const rrgData = rrg && rrg.sectors ? rrg.sectors.find(s => s.key === r.id) : null;
      const series = rrgData?.series || [];
      const latestRrg = series.length ? series[series.length - 1] : null;
      const prevRrg = series.length >= 2 ? series[series.length - 2] : null;
      const quadrant = rrgData?.quadrant || 'Unknown';
      const prevQuadrant = prevRrg ? quadrantOf(prevRrg.rsRatio, prevRrg.rsMomentum) : 'Unknown';

      const kiteScore = scoreMap[r.id];
      const dayChange = r['1D'] ?? 0;

      let marketSignal = {
        label: '⚖️ NEUTRAL', bg: 'transparent', color: 'var(--text-secondary)',
        pulse: false, title: '', rank: 1, border: 'none', isNew: false,
        logicDesc: 'Sector does not currently meet any extreme algorithmic conditions.'
      };

      if (rrgData && latestRrg && kiteScore != null) {
        const ratio = latestRrg.rsRatio;
        const momentum = latestRrg.rsMomentum;

        // 3-session acceleration check (requires >=4 weekly points)
        let momentum3SessUp = false;
        if (series.length >= 4) {
          const [m4, m3, m2, m1] = [series[series.length - 4], series[series.length - 3], series[series.length - 2], series[series.length - 1]].map(p => p.rsMomentum);
          momentum3SessUp = m1 > m2 && m2 > m3 && m3 > m4;
        }

        // Week-over-week deltas
        const ratioDelta = prevRrg ? latestRrg.rsRatio - prevRrg.rsRatio : 0;
        const momentumDelta = prevRrg ? latestRrg.rsMomentum - prevRrg.rsMomentum : 0;

        // "Was this already a leader last week?" used for the NEW pulse on Diamonds / Leaders.
        const prevWasLeaderOrImproving = prevRrg
          ? ((prevRrg.rsRatio > 102 && prevRrg.rsMomentum > 101)
             || (prevQuadrant === 'Improving' && prevRrg.rsMomentum > 101))
          : false;

        if (ratio > 102 && momentum > 101 && kiteScore > 90) {
          marketSignal = {
            label: '🚀 HIGH-CONVICTION BUY', bg: '#10b981', color: '#fff', pulse: true,
            title: "The Leader. Everything is aligned for a strong uptrend.",
            rank: 5, border: 'none', isNew: !prevWasLeaderOrImproving,
            logicDesc: "Drastically outperforming the market, upward momentum accelerating, trend indicators show intense buying pressure."
          };
        } else if (quadrant === 'Leading' && momentumDelta < 0 && kiteScore > 60) {
          marketSignal = {
            label: '🏁 LEADING (MATURE)', bg: '#16a34a', color: '#fff', pulse: false,
            title: "Still leading but losing steam — watch for the handoff.",
            rank: 4, border: 'none', isNew: prevQuadrant !== 'Leading' ? false : false,
            logicDesc: "Sector is still in the Leading quadrant (ratio ≥ 100, momentum ≥ 100), but RS-Momentum is decelerating week-over-week. Rallies like this often hand off before rolling over."
          };
        } else if (quadrant === 'Improving' && momentum > 101 && momentum3SessUp && kiteScore > 65) {
          marketSignal = {
            label: '💎 DIAMOND IN THE ROUGH', bg: '#0ea5e9', color: '#000', pulse: false,
            title: "The Reversal. Climbing out of the hole with real velocity.",
            rank: 3, border: 'none', isNew: !prevWasLeaderOrImproving,
            logicDesc: "Previously lagging but now showing consistent, accelerating momentum over three sessions — strong potential reversal."
          };
        } else if (quadrant === 'Lagging' && momentumDelta > 0 && ratioDelta > 0) {
          marketSignal = {
            label: '🌱 LAGGING (STABILIZING)', bg: '#0369a1', color: '#fff', pulse: false,
            title: "Underperformer starting to heal.",
            rank: 2, border: 'none', isNew: false,
            logicDesc: "Sector is still Lagging, but both RS-Ratio and RS-Momentum ticked up week-over-week. Early stabilization — not yet an entry, but worth tracking."
          };
        } else if (dayChange > 1 && quadrant === 'Lagging' && momentum < 101) {
          marketSignal = {
            label: '💀 TRAP ZONE', bg: '#8b0000', color: '#fff', pulse: false,
            title: "Dead cat bounce. Looks like a rally, but relative strength isn't there.",
            rank: 0, border: '1px solid #eab308', isNew: false,
            logicDesc: "Strong up-day today, but broader momentum is still deeply negative. Likely a fake-out."
          };
        } else if (quadrant === 'Weakening' && momentum < 99 && dayChange < 0) {
          marketSignal = {
            label: '⚠️ STRENGTH FADING', bg: '#f97316', color: '#000', pulse: false,
            title: "The engine is sputtering. Time to look at exits.",
            rank: 1, border: 'none', isNew: false,
            logicDesc: "Losing leadership, underlying momentum dropping, and recent daily performance is negative."
          };
        } else if (ratio < 95 && momentum < 95) {
          marketSignal = {
            label: '🛡️ CAPITAL PRESERVATION', bg: '#374151', color: '#e5e7eb', pulse: false,
            title: "Dead money. Do not touch.",
            rank: 0, border: 'none', isNew: false,
            logicDesc: "Both long-term RS and short-term momentum are severely broken."
          };
        }
      }

      return {
        ...r,
        momentumScore: kiteScore ?? null,
        momentumBreakdown: breakdownById[r.id] || null,
        rs1M: r['1M'] !== null && benchmark1M !== null ? r['1M'] - benchmark1M : null,
        rs1MBenchmark: benchmarkShort,
        rrgRatio: latestRrg ? latestRrg.rsRatio : null,
        rrgMomentum: latestRrg ? latestRrg.rsMomentum : null,
        rrgQuadrant: quadrant,
        rrgMomentumDelta: (latestRrg && prevRrg) ? latestRrg.rsMomentum - prevRrg.rsMomentum : null,
        marketSignal,
        signalRank: marketSignal.rank
      };
    });
  }, [data, rrg, rrgBenchmark, activeTab]);

  const sortedData = useMemo(() => {
    const arr = [...enrichedData];
    arr.sort((a, b) => {
      let valA = a[sortConfig.key];
      let valB = b[sortConfig.key];
      if (valA === null || valA === undefined) valA = sortConfig.direction === 'asc' ? Infinity : -Infinity;
      if (valB === null || valB === undefined) valB = sortConfig.direction === 'asc' ? Infinity : -Infinity;
      if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
      if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [enrichedData, sortConfig]);

  const filteredData = useMemo(
    () => sortedData.filter(row => row.name.toLowerCase().includes(searchQuery.toLowerCase())),
    [sortedData, searchQuery]
  );

  // ─── CSV export (visible rows) ────────────────────────────────
  const exportCSV = useCallback(() => {
    const rows = filteredData;
    if (!rows.length) return;
    const headers = [
      'Name', 'Category', 'Price', '1D%', '1W%', '1M%', '3M%', '6M%', '1Y%', '3Y%', '5Y%',
      'RS-Ratio', 'RS-Momentum', 'Quadrant', 'RSI14', 'MomentumScore', '1M-RS',
      '%52W-High', 'Signal'
    ];
    const fmt = (v) => (v === null || v === undefined) ? '' : (typeof v === 'number' ? v.toFixed(2) : String(v));
    const esc = (v) => {
      const s = fmt(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push([
        r.name, r.category, r.price,
        r['1D'], r['1W'], r['1M'], r['3M'], r['6M'], r['1Y'], r['3Y'], r['5Y'],
        r.rrgRatio, r.rrgMomentum, r.rrgQuadrant, r.rsi14, r.momentumScore, r.rs1M,
        r.dist52WHigh, r.marketSignal?.label || ''
      ].map(esc).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `indices-${activeTab}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [filteredData, activeTab]);

  const renderSortIndicator = (key) => {
    if (sortConfig.key === key) {
      return sortConfig.direction === 'asc' ? ' ↑' : ' ↓';
    }
    return '';
  };

  const Cell = useCallback(({ value, isHeatmapCell = true }) => {
    if (value === null || value === undefined) return (
      <td style={{ padding: '0.5rem', color: 'var(--text-secondary)' }}>—</td>
    );
    if (value === 0) return <td style={{ padding: '0.5rem', color: 'var(--text-secondary)' }}>0.00%</td>;

    let style = { fontWeight: '500', padding: '0.5rem' };
    let className = value > 0 ? 'positive' : 'negative';

    if (isHeatmap && isHeatmapCell) {
      const alpha = Math.min(Math.abs(value) / 10, 0.9);
      const bg = value > 0 ? `rgba(16, 185, 129, ${alpha})` : `rgba(239, 68, 68, ${alpha})`;
      style = { ...style, backgroundColor: bg, color: '#fff', fontWeight: '600' };
      className = '';
    }

    return (
      <td className={className} style={style}>
        {value > 0 ? '+' : ''}{value.toFixed(2)}%
      </td>
    );
  }, [isHeatmap]);

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
              <Tooltip 
                content={({ active, payload }) => {
                  if (!active || !payload || !payload.length) return null;
                  return (
                    <div style={{ background: '#1a1a2e', padding: '0.3rem 0.6rem', borderRadius: '4px', border: '1px solid var(--border)', fontSize: '0.75rem', color: '#fff', zIndex: 1000, position: 'relative' }}>
                      ₹{payload[0].value.toFixed(2)}
                    </div>
                  );
                }}
                cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1 }}
                isAnimationActive={false}
              />
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
      </header>

      {/* Tabs and Controls */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {[
            { key: 'sector', label: 'Sectors' },
            { key: 'broad', label: 'Broad Market' },
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => {
                setActiveTab(tab.key);
                if (!loadedTabs.has(tab.key)) {
                  setLoadedTabs(prev => {
                    const next = new Set(prev);
                    next.add(tab.key);
                    return next;
                  });
                }
              }}
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
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          {lastUpdated && (
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}
              title={lastUpdated.toLocaleString()}>
              ● Live · {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setShowColumnMenu(v => !v)}
              style={{
                padding: '0.4rem 0.8rem', borderRadius: '6px',
                border: '1px solid var(--border)', background: 'rgba(255,255,255,0.03)',
                color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.8rem'
              }}
            >
              Columns ▾
            </button>
            {showColumnMenu && (
              <div style={{
                position: 'absolute', top: '100%', right: 0, marginTop: '4px',
                background: '#1a1a2e', border: '1px solid var(--border)', borderRadius: '6px',
                padding: '0.5rem', zIndex: 20, minWidth: '140px',
                boxShadow: '0 4px 16px rgba(0,0,0,0.4)'
              }}>
                {Object.keys(hiddenColumns).map(col => (
                  <label key={col} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0.4rem', fontSize: '0.8rem', cursor: 'pointer', color: 'var(--text-primary)' }}>
                    <input
                      type="checkbox"
                      checked={!hiddenColumns[col]}
                      onChange={() => setHiddenColumns(h => ({ ...h, [col]: !h[col] }))}
                    />
                    Show {col}
                  </label>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={exportCSV}
            style={{
              padding: '0.4rem 0.8rem', borderRadius: '6px',
              border: '1px solid var(--accent)', background: 'rgba(0,188,212,0.1)',
              color: 'var(--accent)', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600
            }}
            title="Export visible rows as CSV"
          >
            ⬇ CSV
          </button>
        </div>
      </div>

      {/* Momentum Score Bar Chart */}
      <style>{`
        @keyframes pulse-glow {
          0%, 100% { opacity: 1; transform: scale(1); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
          50% { opacity: 0.9; transform: scale(1.03); box-shadow: 0 0 10px 4px rgba(16, 185, 129, 0) }
        }
        .pulse-glow { animation: pulse-glow 2s infinite; }
      `}</style>
      {(() => {
        const getBarColor = (score) => {
          if (score >= 80) return '#10b981';
          if (score >= 60) return '#6ee7b7';
          if (score >= 40) return '#94a3b8';
          if (score >= 20) return '#fca5a5';
          return '#ef4444';
        };

        const scored = filteredData.filter(r => r.momentumScore != null);
        if (scored.length === 0) return null;

        const shortName = (r) => {
          const s = r.name.replace('NIFTY ', '');
          return /^\d+$/.test(s) ? r.name : s;
        };

        const topData = [...scored].sort((a, b) => b.momentumScore - a.momentumScore).slice(0, 10)
          .map(r => ({ name: shortName(r), score: r.momentumScore }));
        const bottomData = [...scored].sort((a, b) => a.momentumScore - b.momentumScore).slice(0, 10)
          .map(r => ({ name: shortName(r), score: r.momentumScore }));

        const renderBarChart = (chartData, title, subtitle) => (
          <section className="glass-panel" style={{ padding: '1.25rem', flex: 1, minWidth: '320px' }}>
            <h3 style={{ margin: '0 0 0.25rem 0', fontSize: '1rem' }}>{title}</h3>
            <p style={{ margin: '0 0 0.75rem 0', color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{subtitle}</p>
            <div style={{ width: '100%', height: Math.max(200, chartData.length * 38) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 40, left: 10, bottom: 5 }}>
                  <XAxis type="number" domain={[0, 100]} tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
                  <YAxis type="category" dataKey="name" width={120} tick={{ fill: 'var(--text-primary)', fontSize: 12 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload || !payload.length) return null;
                      const d = payload[0];
                      return (
                        <div style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '8px', padding: '0.6rem 1rem', boxShadow: '0 4px 16px rgba(0,0,0,0.4)' }}>
                          <p style={{ margin: 0, fontWeight: 600, color: '#fff', fontSize: '0.9rem' }}>{d.payload.name}</p>
                          <p style={{ margin: '0.25rem 0 0', color: getBarColor(d.value), fontWeight: 700, fontSize: '1.1rem' }}>Score: {d.value}</p>
                        </div>
                      );
                    }}
                    cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                  />
                  <Bar dataKey="score" radius={[0, 6, 6, 0]} barSize={22} label={{ position: 'right', fill: 'var(--text-secondary)', fontSize: 12, fontWeight: 600 }}>
                    {chartData.map((entry, index) => (
                      <RechartsCell key={`cell-${index}`} fill={getBarColor(entry.score)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
        );

        return (
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
            {renderBarChart(topData, `Top 10 — ${activeTab === 'sector' ? 'Sectors' : 'Indices'}`, 'Strongest momentum (1W · 1M · 3M weighted, RSI-adjusted)')}
            {renderBarChart(bottomData, `Bottom 10 — ${activeTab === 'sector' ? 'Sectors' : 'Indices'}`, 'Weakest momentum — underperformers to avoid')}
          </div>
        );
      })()}

      {/* ─── Relative Rotation Graph ──────────────────────────── */}
      {activeTab === 'sector' && <RRGChart
        rrg={rrg}
        rrgLoading={rrgLoading}
        rrgBenchmark={rrgBenchmark}
        setRrgBenchmark={setRrgBenchmark}
        rrgTailLength={rrgTailLength}
        setRrgTailLength={setRrgTailLength}
        rrgHidden={rrgHidden}
        setRrgHidden={setRrgHidden}
        rrgAnimating={rrgAnimating}
        setRrgAnimating={setRrgAnimating}
        rrgAnimFrame={rrgAnimFrame}
        setRrgAnimFrame={setRrgAnimFrame}
        rrgScrubEnd={rrgScrubEnd}
        setRrgScrubEnd={setRrgScrubEnd}
        rrgAnimRef={rrgAnimRef}
        rrgTooltip={rrgTooltip}
        setRrgTooltip={setRrgTooltip}
        rrgSvgRef={rrgSvgRef}
        rrgContainerRef={rrgContainerRef}
        navigate={navigate}
      />}

      <section className="glass-panel" style={{ padding: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', paddingBottom: '1rem', borderBottom: '1px solid rgba(255,255,255,0.05)', gap: '1rem', flexWrap: 'wrap' }}>
          <div>
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search indices... (Cmd/Ctrl+K)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                padding: '0.6rem 1rem',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                background: 'var(--bg-dark)',
                color: 'var(--text-primary)',
                width: '280px',
                fontSize: '1rem',
                outline: 'none'
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            {isHeatmap && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                <span>-10%</span>
                <div style={{ width: '120px', height: '10px', borderRadius: '2px', background: 'linear-gradient(to right, rgba(239,68,68,0.9), rgba(255,255,255,0.04), rgba(16,185,129,0.9))', border: '1px solid var(--border)' }} />
                <span>+10%</span>
              </div>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.9rem', color: 'var(--text-primary)', fontWeight: '600' }}>
              <input
                type="checkbox"
                checked={isHeatmap}
                onChange={e => setIsHeatmap(e.target.checked)}
                style={{ cursor: 'pointer', width: '16px', height: '16px' }}
              />
              Heatmap
            </label>
          </div>
        </div>

        <div style={{ maxHeight: '70vh', overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'right', fontSize: '0.85rem' }}>
          <thead style={{ position: 'sticky', top: 0, background: '#0f0f1e', zIndex: 5 }}>
            <tr>
              <th onClick={() => requestSort('name')} style={{ textAlign: 'left', cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', background: '#0f0f1e' }}>
                Index {renderSortIndicator('name')}
              </th>
              <th onClick={() => requestSort('price')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', background: '#0f0f1e' }}>
                Price {renderSortIndicator('price')}
              </th>
              <th onClick={() => requestSort('1D')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', background: '#0f0f1e' }}>
                1D {renderSortIndicator('1D')}
              </th>
              {!hiddenColumns['1W'] && (
                <th onClick={() => requestSort('1W')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', background: '#0f0f1e' }}>
                  1W {renderSortIndicator('1W')}
                </th>
              )}
              <th onClick={() => requestSort('1M')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', background: '#0f0f1e' }}>
                1M {renderSortIndicator('1M')}
              </th>
              <th onClick={() => requestSort('rs1M')} title={`1-Month Relative Strength vs ${rrgBenchmark.split(':')[1]}`} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', background: '#0f0f1e' }}>
                RS vs {(rrgBenchmark.split(':')[1] || '').replace('NIFTY ', '') || 'BM'} {renderSortIndicator('rs1M')}
              </th>
              {activeTab !== 'broad' && (
                <>
                  <th onClick={() => requestSort('rrgRatio')} title={`JdK RS-Ratio against ${rrgBenchmark.split(':')[1]}`} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', background: '#0f0f1e' }}>
                    RS-Ratio {renderSortIndicator('rrgRatio')}
                  </th>
                  <th onClick={() => requestSort('rrgMomentum')} title={`JdK RS-Momentum against ${rrgBenchmark.split(':')[1]}`} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', background: '#0f0f1e' }}>
                    RS-Momentum {renderSortIndicator('rrgMomentum')}
                  </th>
                </>
              )}
              <th onClick={() => requestSort('3M')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', background: '#0f0f1e' }}>
                3M {renderSortIndicator('3M')}
              </th>
              {!hiddenColumns['6M'] && (
                <th onClick={() => requestSort('6M')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', background: '#0f0f1e' }}>
                  6M {renderSortIndicator('6M')}
                </th>
              )}
              <th onClick={() => requestSort('1Y')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', background: '#0f0f1e' }}>
                1Y {renderSortIndicator('1Y')}
              </th>
              <th onClick={() => requestSort('dist52WHigh')} title="% Distance from 52-Week High" style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', background: '#0f0f1e' }}>
                % 52W H {renderSortIndicator('dist52WHigh')}
              </th>
              {!hiddenColumns['3Y'] && (
                <th onClick={() => requestSort('3Y')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', background: '#0f0f1e' }}>
                  3Y {renderSortIndicator('3Y')}
                </th>
              )}
              {!hiddenColumns['5Y'] && (
                <th onClick={() => requestSort('5Y')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', background: '#0f0f1e' }}>
                  5Y {renderSortIndicator('5Y')}
                </th>
              )}
              <th onClick={() => requestSort('rsi14')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', textAlign: 'center', background: '#0f0f1e' }}>
                RSI {renderSortIndicator('rsi14')}
              </th>
              <th onClick={() => requestSort('momentumScore')} title="Ranks sectors by recent trend strength (1-100). Higher = stronger momentum. Hover the score for a breakdown." style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', textAlign: 'center', background: '#0f0f1e' }}>
                Momentum {renderSortIndicator('momentumScore')}
              </th>
              {activeTab !== 'broad' && (
                <th onClick={() => requestSort('signalRank')} title="Automated intelligence analyzing trend, strength and momentum" style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)', textAlign: 'center', background: '#0f0f1e' }}>
                  Signal {renderSortIndicator('signalRank')}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {filteredData.length > 0 ? filteredData.map((row, idx) => {
              const openRow = () => {
                if (!row.token) return;
                if (row.category === 'sector') {
                  navigate(`/sector/${encodeURIComponent(row.id)}`, {
                    state: { momentumScore: row.momentumScore, rrgQuadrant: row.rrgQuadrant }
                  });
                } else {
                  navigate(`/instrument/${row.token}?symbol=${row.id.split(':')[1]}`);
                }
              };
              const delta = row.rrgMomentumDelta;
              return (
              <tr
                key={row.id}
                tabIndex={row.token ? 0 : -1}
                onClick={openRow}
                onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && row.token) { e.preventDefault(); openRow(); } }}
                style={{ cursor: row.token ? 'pointer' : 'default', borderBottom: idx !== filteredData.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none', transition: 'background 0.2s', outline: 'none' }}
                onMouseOver={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
                onFocus={(e) => e.currentTarget.style.background = 'rgba(0,188,212,0.05)'}
                onBlur={(e) => e.currentTarget.style.background = 'transparent'}
              >
                <td style={{ textAlign: 'left', padding: '0.5rem', fontWeight: 'bold' }}>
                  {row.name}
                  {row.marketSignal && row.marketSignal.isNew && (
                    <span style={{ marginLeft: '0.5rem', fontSize: '0.65rem', background: '#ef4444', color: '#fff', padding: '0.1rem 0.3rem', borderRadius: '4px', fontWeight: 'bold', verticalAlign: 'middle', animation: 'pulse-glow 2s infinite' }}>NEW</span>
                  )}
                </td>
                <td style={{ padding: '0.5rem', color: 'var(--text-primary)' }}>₹{row.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                <Cell value={row['1D']} />
                {!hiddenColumns['1W'] && <Cell value={row['1W']} />}
                <Cell value={row['1M']} />
                <Cell value={row.rs1M} isHeatmapCell={false} />
                {activeTab !== 'broad' && (
                  <>
                    <td style={{ padding: '0.5rem', color: row.rrgRatio >= 100 ? '#10b981' : '#ef4444', fontWeight: '600' }}>
                      {row.rrgRatio != null ? row.rrgRatio.toFixed(2) : '-'}
                    </td>
                    <td style={{ padding: '0.5rem', color: row.rrgMomentum >= 100 ? '#10b981' : '#ef4444', fontWeight: '600' }}>
                      {row.rrgMomentum != null ? row.rrgMomentum.toFixed(2) : '-'}
                    </td>
                  </>
                )}
                <Cell value={row['3M']} />
                {!hiddenColumns['6M'] && <Cell value={row['6M']} />}
                <Cell value={row['1Y']} />
                <Cell value={row.dist52WHigh} isHeatmapCell={false} />
                {!hiddenColumns['3Y'] && <Cell value={row['3Y']} />}
                {!hiddenColumns['5Y'] && <Cell value={row['5Y']} />}
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
                <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center', position: 'relative' }}
                    onMouseEnter={() => row.momentumBreakdown && setMomentumPopover(row.id)}
                    onMouseLeave={() => setMomentumPopover(null)}>
                  {row.momentumScore == null ? (
                    <div className="loader" style={{ width: '16px', height: '16px', margin: '0 auto', borderWidth: '2px' }}></div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', cursor: 'help' }}>
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
                      {delta != null && delta > 0 && (
                        <span title="RS-Momentum improving week-over-week" style={{ color: '#10b981', fontSize: '0.8rem', fontWeight: 'bold' }}>▲</span>
                      )}
                      {delta != null && delta < 0 && (
                        <span title="RS-Momentum declining week-over-week" style={{ color: '#ef4444', fontSize: '0.8rem', fontWeight: 'bold' }}>▼</span>
                      )}
                    </div>
                  )}
                  {momentumPopover === row.id && row.momentumBreakdown && (
                    <div onClick={(e) => e.stopPropagation()} style={{
                      position: 'absolute', right: '50%', top: '100%', transform: 'translateX(50%)', marginTop: '4px',
                      background: '#0f172a', border: '1px solid #334155', borderRadius: '6px',
                      padding: '0.6rem 0.75rem', minWidth: '240px', zIndex: 30,
                      boxShadow: '0 8px 24px rgba(0,0,0,0.6)', fontFamily: "'JetBrains Mono', monospace",
                      textAlign: 'left', whiteSpace: 'normal'
                    }}>
                      <div style={{ fontSize: '0.7rem', color: '#cbd5e1', fontWeight: 700, letterSpacing: '1px', borderBottom: '1px solid #334155', paddingBottom: '0.3rem', marginBottom: '0.4rem' }}>
                        SCORE BREAKDOWN — {row.momentumScore}
                      </div>
                      {[
                        { label: `1W × ${W_1W.toFixed(2)}`, value: row.momentumBreakdown.w1w },
                        { label: `1M × ${W_1M.toFixed(2)}`, value: row.momentumBreakdown.w1m },
                        { label: `3M × ${W_3M.toFixed(2)}`, value: row.momentumBreakdown.w3m },
                      ].map((it, i) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', padding: '0.1rem 0' }}>
                          <span style={{ color: '#cbd5e1' }}>{it.label}</span>
                          <span style={{ color: it.value >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                            {it.value >= 0 ? '+' : ''}{it.value.toFixed(2)}
                          </span>
                        </div>
                      ))}
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', padding: '0.15rem 0', borderTop: '1px dashed #334155', marginTop: '0.25rem' }}>
                        <span style={{ color: '#94a3b8' }}>Raw weighted</span>
                        <span style={{ color: '#cbd5e1', fontWeight: 600 }}>{row.momentumBreakdown.raw.toFixed(2)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', padding: '0.15rem 0' }}>
                        <span style={{ color: '#94a3b8' }}>RSI({row.rsi14 ?? '—'}) multiplier</span>
                        <span style={{ color: row.momentumBreakdown.rsiMult === 1 ? '#94a3b8' : row.momentumBreakdown.rsiMult > 1 ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                          ×{row.momentumBreakdown.rsiMult.toFixed(2)}
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', padding: '0.3rem 0 0 0', borderTop: '1px solid #334155', marginTop: '0.3rem' }}>
                        <span style={{ color: '#cbd5e1', fontWeight: 700 }}>Adjusted</span>
                        <span style={{ color: '#fff', fontWeight: 700 }}>{row.momentumBreakdown.adjusted.toFixed(2)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', padding: '0.1rem 0' }}>
                        <span style={{ color: '#94a3b8' }}>Percentile rank</span>
                        <span style={{ color: '#38bdf8', fontWeight: 700 }}>{row.momentumBreakdown.percentile}</span>
                      </div>
                    </div>
                  )}
                </td>
                {activeTab !== 'broad' && (
                  <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>
                    {row.marketSignal && (
                      <span
                        onClick={(e) => { e.stopPropagation(); setActiveSignalModal(row); }}
                        title="Click to see algorithmic breakdown"
                        className={row.marketSignal.pulse ? 'pulse-glow' : ''}
                        style={{
                          display: 'inline-block',
                          padding: '0.2rem 0.6rem',
                          borderRadius: '6px',
                          fontSize: '0.75rem',
                          fontWeight: '700',
                          cursor: 'pointer',
                          background: row.marketSignal.bg,
                          color: row.marketSignal.color,
                          border: row.marketSignal.border,
                          whiteSpace: 'nowrap'
                      }}>
                        {row.marketSignal.label}
                      </span>
                    )}
                  </td>
                )}
              </tr>
            );
            }) : (
              <tr>
                <td colSpan="16" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No indices match your search.</td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </section>

      {/* Signal Education Modal */}
      {activeSignalModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)', zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }} onClick={() => setActiveSignalModal(null)}>
          <div style={{
            background: '#1a1a2e', padding: '2rem', borderRadius: '12px',
            border: '1px solid rgba(255,255,255,0.1)', maxWidth: '400px', width: '90%',
            boxShadow: '0 10px 40px rgba(0,0,0,0.5)'
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
              <div>
                <h3 style={{ margin: '0 0 0.5rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ 
                    background: activeSignalModal.marketSignal.bg, color: activeSignalModal.marketSignal.color, 
                    padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem', border: activeSignalModal.marketSignal.border 
                  }}>{activeSignalModal.marketSignal.label}</span>
                </h3>
                <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>{activeSignalModal.name}</p>
              </div>
              <button onClick={() => setActiveSignalModal(null)} style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '1.5rem', cursor: 'pointer' }}>&times;</button>
            </div>
            
            <p style={{ fontSize: '0.95rem', lineHeight: '1.5', margin: '0 0 1.5rem 0' }}>
              {activeSignalModal.marketSignal.title}
            </p>

            <div style={{ background: 'rgba(255,255,255,0.03)', padding: '1rem', borderRadius: '8px', marginBottom: '1.5rem' }}>
              <h4 style={{ margin: '0 0 0.75rem 0', fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Algorithmic Criteria Met:</h4>
              <p style={{ margin: 0, fontSize: '0.9rem', color: '#38bdf8', lineHeight: '1.5' }}>
                {activeSignalModal.marketSignal.logicDesc}
              </p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Kite Momentum</span>
                <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{activeSignalModal.momentumScore ?? '-'}</div>
              </div>
              <div>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>RRG Quadrant</span>
                <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{activeSignalModal.rrgQuadrant ?? '-'}</div>
              </div>
              <div>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>RS-Ratio</span>
                <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{activeSignalModal.rrgRatio ? activeSignalModal.rrgRatio.toFixed(2) : '-'}</div>
              </div>
              <div>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>RS-Momentum</span>
                <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{activeSignalModal.rrgMomentum ? activeSignalModal.rrgMomentum.toFixed(2) : '-'}</div>
              </div>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}

export default SectorIndices;

