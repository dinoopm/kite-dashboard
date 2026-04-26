import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Cell as RechartsCell, ResponsiveContainer } from 'recharts';
import RRGChart from '../components/RRGChart';

const API = import.meta.env.VITE_API_URL || '';

const W_1W = 0.20, W_1M = 0.50, W_3M = 0.30;
const RSI_MULT_SEVERE_OVERBOUGHT = 0.85;
const RSI_MULT_OVERBOUGHT = 0.92;
const RSI_MULT_OVERSOLD = 1.08;
const RSI_MULT_SEVERE_OVERSOLD = 1.15;

const HIST_FETCH_DELAY_MS = 1500;
const HIST_CACHE_DELAY_MS = 50;
const RRG_POLL_MS = 10_000;
const RRG_MAX_WARMUP_POLLS = 18;

// ─── Utility ─────────────────────────────────────────────────────────
function calculateHistoricalReturns(series, currentPrice) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  const nowIST = new Date(`${y}-${m}-${d}T00:00:00Z`);

  const dates = series.map(c => new Date(c.date).getTime());

  const getPriceAtDate = (targetDate) => {
    if (dates.length === 0) return 0;
    const target = targetDate.getTime();
    let lo = 0, hi = dates.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] < target) lo = mid + 1;
      else hi = mid;
    }
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
  };
}

function computeRsi14(sorted) {
  if (!sorted || sorted.length < 15) return null;
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
  return parseFloat((100 - 100 / (1 + rs)).toFixed(1));
}

function rsiMultiplierFor(rsi14) {
  if (rsi14 == null) return 1.0;
  if (rsi14 >= 80) return RSI_MULT_SEVERE_OVERBOUGHT;
  if (rsi14 >= 70) return RSI_MULT_OVERBOUGHT;
  if (rsi14 <= 20) return RSI_MULT_SEVERE_OVERSOLD;
  if (rsi14 <= 30) return RSI_MULT_OVERSOLD;
  return 1.0;
}

function computeSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function resampleToWeeklyHighs(sortedDailyData) {
  if (!sortedDailyData || sortedDailyData.length === 0) return [];
  const weeks = {};
  for (const c of sortedDailyData) {
    const d = new Date(c.date);
    const day = d.getDay();
    const diff = 5 - day;
    const friday = new Date(d);
    friday.setDate(d.getDate() + diff);
    const weekKey = friday.toISOString().split('T')[0];
    if (!weeks[weekKey]) weeks[weekKey] = { weekKey, high: c.high ?? c.close, close: c.close, date: c.date };
    else {
      const h = c.high ?? c.close;
      if (h > weeks[weekKey].high) weeks[weekKey].high = h;
      weeks[weekKey].close = c.close;
      weeks[weekKey].date = c.date;
    }
  }
  return Object.values(weeks).sort((a, b) => a.weekKey.localeCompare(b.weekKey));
}

// ─── Colour helpers ──────────────────────────────────────────────────
const pctColor = (v) => {
  if (v == null) return 'var(--text-secondary)';
  if (v > 0) return '#22c55e';
  if (v < 0) return '#ef4444';
  return 'var(--text-secondary)';
};

const fmtPct = (v) => {
  if (v == null) return '–';
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
};

// ─── MA Breadth Card ─────────────────────────────────────────────────
function MaBreadthCard({ title, subtitle, pct, aboveNames, belowNames }) {
  const color = pct >= 60 ? '#10b981' : pct >= 40 ? '#eab308' : '#ef4444';
  const bg = pct >= 60 ? '#10b98118' : pct >= 40 ? '#eab30818' : '#ef444418';
  return (
    <div style={{ flex: '1 1 320px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '1rem 1.25rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
        <div>
          <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginTop: '0.1rem' }}>{subtitle}</div>
        </div>
        <span style={{ fontSize: '1.4rem', fontWeight: 800, color, background: bg, padding: '0.2rem 0.6rem', borderRadius: '6px' }}>
          {Math.round(pct)}%
        </span>
      </div>
      {/* Progress bar */}
      <div style={{ height: '5px', borderRadius: '3px', background: 'rgba(255,255,255,0.08)', marginBottom: '1rem', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.round(pct)}%`, background: color, borderRadius: '3px', transition: 'width 0.6s ease' }} />
      </div>
      {/* Above / Below columns */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <div>
          <div style={{ fontSize: '0.65rem', fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.4rem' }}>
            Above ({aboveNames.length})
          </div>
          {aboveNames.map(n => (
            <div key={n} style={{ fontSize: '0.72rem', color: 'var(--text-primary)', padding: '0.15rem 0', borderBottom: '1px solid rgba(255,255,255,0.04)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n}</div>
          ))}
        </div>
        <div>
          <div style={{ fontSize: '0.65rem', fontWeight: 700, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.4rem' }}>
            Below ({belowNames.length})
          </div>
          {belowNames.map(n => (
            <div key={n} style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', padding: '0.15rem 0', borderBottom: '1px solid rgba(255,255,255,0.04)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Sortable column header ──────────────────────────────────────────
function SortTh({ label, sortKey, sortConfig, onSort, style }) {
  const active = sortConfig.key === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      style={{ cursor: 'pointer', padding: '0.5rem', whiteSpace: 'nowrap', userSelect: 'none', color: active ? 'var(--accent)' : 'var(--text-secondary)', ...style }}
    >
      {label} {active ? (sortConfig.direction === 'desc' ? '▼' : '▲') : '↕'}
    </th>
  );
}

// ─── Main page ───────────────────────────────────────────────────────
export default function SectorDetail() {
  const { sectorId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const sectorKey = decodeURIComponent(sectorId);
  const sectorName = sectorKey.split(':')[1] || sectorKey;

  const { momentumScore: inheritedScore = null, rrgQuadrant: inheritedQuadrant = null } = location.state || {};

  // ── Phase 1 state ──
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sectorQuote, setSectorQuote] = useState(null);  // { price, change1D }
  const [sectorToken, setSectorToken] = useState(null);
  const [sectorReturns, setSectorReturns] = useState(null);
  const [sectorHistory, setSectorHistory] = useState([]);
  const [sectorRsi14, setSectorRsi14] = useState(null);
  const [nifty50Returns, setNifty50Returns] = useState(null);
  const [constituents, setConstituents] = useState([]);

  // ── Phase 2 state ──
  const [stockData, setStockData] = useState([]);
  const [histLoadedCount, setHistLoadedCount] = useState(0);

  // ── RRG state ──
  const [rrg, setRrg] = useState(null);
  const [rrgLoading, setRrgLoading] = useState(true);
  const [rrgBenchmark] = useState(sectorKey);
  const [rrgTailLength, setRrgTailLength] = useState(6);
  const [rrgHidden, setRrgHidden] = useState({});
  const [rrgAnimating, setRrgAnimating] = useState(false);
  const [rrgAnimFrame, setRrgAnimFrame] = useState(0);
  const [rrgScrubEnd, setRrgScrubEnd] = useState(null);
  const [rrgTooltip, setRrgTooltip] = useState(null);
  const rrgAnimRef = useRef(null);
  const rrgSvgRef = useRef(null);
  const rrgContainerRef = useRef(null);
  const rrgPollCount = useRef(0);
  const rrgPollTimer = useRef(null);

  // ── UI state ──
  const [activeTab, setActiveTab] = useState('overview');
  const [sortConfig, setSortConfig] = useState({ key: 'momentumScore', direction: 'desc' });
  const [searchQuery, setSearchQuery] = useState('');

  const mountedRef = useRef(true);
  useEffect(() => { return () => { mountedRef.current = false; }; }, []);

  // ─── Phase 1: load sector header + constituents ───────────────────
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // Fetch sector + NIFTY 50 quotes
        const qRes = await fetch(`${API}/api/quotes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instruments: [sectorKey, 'NSE:NIFTY 50'] })
        });
        const qRaw = await qRes.json();
        const quotes = qRaw?.content?.[0]?.text ? JSON.parse(qRaw.content[0].text) : {};
        const sq = quotes[sectorKey];
        const nq = quotes['NSE:NIFTY 50'];

        if (!cancelled && sq) {
          const price = sq.last_price ?? sq.ohlc?.close ?? 0;
          const prevClose = sq.ohlc?.close ?? price;
          const change1D = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
          setSectorQuote({ price, change1D });
          setSectorToken(String(sq.instrument_token));
        }

        const niftyToken = nq?.instrument_token ? String(nq.instrument_token) : null;

        // Parallel: fetch sector history + NIFTY 50 history + constituents
        const [sectorHistRes, niftyHistRes, constRes] = await Promise.allSettled([
          sq?.instrument_token
            ? fetch(`${API}/api/historical-full/${sq.instrument_token}`).then(r => r.json())
            : Promise.resolve(null),
          niftyToken
            ? fetch(`${API}/api/historical-full/${niftyToken}`).then(r => r.json())
            : Promise.resolve(null),
          fetch(`${API}/api/sector-constituents/${encodeURIComponent(sectorKey)}`).then(r => r.json()),
        ]);

        const parseHistPayload = (val) => {
          const txt = val?.content?.[0]?.text;
          if (!txt) return null;
          try { const arr = JSON.parse(txt); return Array.isArray(arr) ? arr : null; } catch { return null; }
        };

        if (!cancelled) {
          // Sector history
          const sectorArr = sectorHistRes.status === 'fulfilled' ? parseHistPayload(sectorHistRes.value) : null;
          if (sectorArr?.length) {
            const sorted = [...sectorArr].sort((a, b) => a.date.localeCompare(b.date));
            const price = sq?.last_price ?? sq?.ohlc?.close ?? sorted[sorted.length - 1]?.close ?? 0;
            setSectorHistory(sorted);
            setSectorReturns(calculateHistoricalReturns(sorted, price));
            setSectorRsi14(computeRsi14(sorted));
          }

          // NIFTY 50 history → returns only
          const niftyArr = niftyHistRes.status === 'fulfilled' ? parseHistPayload(niftyHistRes.value) : null;
          if (niftyArr?.length) {
            const sorted = [...niftyArr].sort((a, b) => a.date.localeCompare(b.date));
            const price = nq?.last_price ?? sorted[sorted.length - 1]?.close ?? 0;
            setNifty50Returns(calculateHistoricalReturns(sorted, price));
          }

          // Constituents
          if (constRes.status === 'fulfilled' && constRes.value?.constituents) {
            setConstituents(constRes.value.constituents);
          } else if (constRes.status === 'fulfilled' && constRes.value?.error) {
            console.warn('sector-constituents:', constRes.value.error);
          }

          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) { setError(err.message); setLoading(false); }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [sectorKey]);

  // ─── Phase 2: progressive stock history ──────────────────────────
  useEffect(() => {
    if (constituents.length === 0) return;
    let cancelled = false;

    async function loadStocks() {
      // Get live prices first
      const instruments = constituents.filter(c => c.token).map(c => c.key);
      if (instruments.length === 0) return;

      const qRes = await fetch(`${API}/api/quotes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruments })
      });
      const qRaw = await qRes.json();
      const quotes = qRaw?.content?.[0]?.text ? JSON.parse(qRaw.content[0].text) : {};

      // Initialise stockData with live quotes
      const initial = constituents.map(c => {
        const q = quotes[c.key];
        const price = q?.last_price ?? q?.ohlc?.close ?? 0;
        const prevClose = q?.ohlc?.close ?? price;
        const change1D = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
        return {
          symbol: c.symbol, name: c.name, key: c.key, token: c.token,
          price, '1D': change1D,
          '1W': null, '1M': null, '3M': null, '6M': null, '1Y': null, '3Y': null,
          rsi14: null, sma20: null, sma200: null, aboveSma20: null, aboveSma200: null,
          weeklyHighs: null, histLoaded: false,
        };
      });
      if (!cancelled) setStockData(initial);

      // Progressively load history
      for (const c of constituents) {
        if (cancelled) break;
        if (!c.token) continue;

        let hitCache = true;
        try {
          const hRes = await fetch(`${API}/api/historical-full/${c.token}`);
          const hData = await hRes.json();
          hitCache = !!hData?.cached;

          let arr = null;
          if (hData?.content?.[0]?.text) {
            try { const p = JSON.parse(hData.content[0].text); if (Array.isArray(p)) arr = p; } catch {}
          }

          if (arr?.length && !cancelled) {
            const sorted = [...arr].sort((a, b) => a.date.localeCompare(b.date));
            const price = sorted[sorted.length - 1]?.close ?? 0;
            const returns = calculateHistoricalReturns(sorted, price);
            const rsi14 = computeRsi14(sorted);
            const closes = sorted.map(cc => cc.close);
            const sma20 = computeSMA(closes, 20);
            const sma200 = computeSMA(closes, 200);
            const lastClose = closes[closes.length - 1];
            const weeklyHighs = resampleToWeeklyHighs(sorted);

            if (!cancelled) {
              setStockData(prev => prev.map(s =>
                s.key === c.key
                  ? { ...s, ...returns, rsi14, sma20, sma200, aboveSma20: sma20 != null ? lastClose >= sma20 : null, aboveSma200: sma200 != null ? lastClose >= sma200 : null, weeklyHighs, histLoaded: true }
                  : s
              ));
              setHistLoadedCount(n => n + 1);
            }
          }
        } catch (e) {
          console.warn('history failed for', c.symbol, e.message);
        }

        if (!cancelled && mountedRef.current) {
          await new Promise(r => setTimeout(r, hitCache ? HIST_CACHE_DELAY_MS : HIST_FETCH_DELAY_MS));
        }
      }
    }

    loadStocks();
    return () => { cancelled = true; };
  }, [constituents]);

  // ─── Phase 3: RRG polling ─────────────────────────────────────────
  const fetchRRG = useCallback(async () => {
    if (constituents.length === 0) return false;
    try {
      const securities = constituents.filter(c => c.key).map(c => c.key).join(',');
      const url = `${API}/api/rrg?benchmark=${encodeURIComponent(sectorKey)}&securities=${encodeURIComponent(securities)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data?.sectors?.length > 0) {
        setRrg(data);
        setRrgLoading(false);
        return true;
      }
    } catch (e) {
      console.warn('RRG fetch failed:', e.message);
    }
    return false;
  }, [sectorKey, constituents]);

  useEffect(() => {
    if (constituents.length === 0) return;
    rrgPollCount.current = 0;
    let stopped = false;

    const poll = async () => {
      if (stopped) return;
      const gotData = await fetchRRG();
      rrgPollCount.current++;
      if (gotData) {
        // Data received — stop polling
        return;
      }
      if (rrgPollCount.current < RRG_MAX_WARMUP_POLLS && mountedRef.current) {
        // Faster early polls (3s for first 3 attempts), then back off to RRG_POLL_MS
        const delay = rrgPollCount.current < 3 ? 3000 : RRG_POLL_MS;
        rrgPollTimer.current = setTimeout(poll, delay);
      } else {
        setRrgLoading(false);
      }
    };
    poll();
    return () => {
      stopped = true;
      if (rrgPollTimer.current) clearTimeout(rrgPollTimer.current);
    };
  }, [constituents, fetchRRG]);

  // ─── Derived / computed ───────────────────────────────────────────
  const enrichedStockData = useMemo(() => {
    const loaded = stockData.filter(s => s.histLoaded);
    if (loaded.length < Math.ceil(constituents.length * 0.6)) return stockData;

    // Compute raw momentum score
    const withRaw = stockData.map(s => {
      if (!s.histLoaded) return { ...s, rawMomentum: null };
      const raw = (s['1W'] ?? 0) * W_1W + (s['1M'] ?? 0) * W_1M + (s['3M'] ?? 0) * W_3M;
      const mult = rsiMultiplierFor(s.rsi14);
      return { ...s, rawMomentum: raw * mult };
    });

    const scorable = withRaw.filter(s => s.rawMomentum !== null);
    if (scorable.length === 0) return withRaw;

    const sorted = [...scorable].sort((a, b) => a.rawMomentum - b.rawMomentum);
    const rankMap = {};
    sorted.forEach((s, i) => {
      rankMap[s.key] = Math.round((i / (sorted.length - 1 || 1)) * 99) + 1;
    });

    return withRaw.map(s => ({
      ...s,
      momentumScore: rankMap[s.key] ?? null,
      rsVsSector: s['1M'] != null && sectorReturns?.['1M'] != null ? s['1M'] - sectorReturns['1M'] : null,
      rsVsNifty: s['1M'] != null && nifty50Returns?.['1M'] != null ? s['1M'] - nifty50Returns['1M'] : null,
    }));
  }, [stockData, constituents.length, sectorReturns, nifty50Returns]);

  const maGaugeData = useMemo(() => {
    const loaded = enrichedStockData.filter(s => s.aboveSma20 !== null);
    if (loaded.length === 0) return null;
    const above20 = loaded.filter(s => s.aboveSma20);
    const above200 = loaded.filter(s => s.aboveSma200);
    return {
      pct20: (above20.length / loaded.length) * 100,
      pct200: (above200.length / loaded.length) * 100,
      above20names: above20.map(s => s.name),
      below20names: loaded.filter(s => !s.aboveSma20).map(s => s.name),
      above200names: above200.map(s => s.name),
      below200names: loaded.filter(s => !s.aboveSma200).map(s => s.name),
    };
  }, [enrichedStockData]);

  const hiddenLeaders = useMemo(() => {
    if (!sectorHistory || sectorHistory.length < 8) return null;
    const sectorWeekly = resampleToWeeklyHighs(sectorHistory);
    if (sectorWeekly.length < 8) return null;

    const recentSector = Math.max(...sectorWeekly.slice(-4).map(w => w.high));
    const priorSector = Math.max(...sectorWeekly.slice(-8, -4).map(w => w.high));
    const sectorIsLowerHigh = recentSector < priorSector;

    if (!sectorIsLowerHigh) return { active: false, leaders: [] };

    const leaders = enrichedStockData.filter(s => {
      if (!s.weeklyHighs || s.weeklyHighs.length < 8) return false;
      const recentStock = Math.max(...s.weeklyHighs.slice(-4).map(w => w.high));
      const priorStock = Math.max(...s.weeklyHighs.slice(-8, -4).map(w => w.high));
      return recentStock > priorStock;
    });

    return { active: true, leaders };
  }, [sectorHistory, enrichedStockData]);

  // ─── Sort & filter for Stocks table ──────────────────────────────
  const sortedStocks = useMemo(() => {
    let rows = [...enrichedStockData];
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter(s => s.name.toLowerCase().includes(q) || s.symbol.toLowerCase().includes(q));
    }
    if (sortConfig.key) {
      rows.sort((a, b) => {
        const av = a[sortConfig.key] ?? -Infinity;
        const bv = b[sortConfig.key] ?? -Infinity;
        return sortConfig.direction === 'desc' ? bv - av : av - bv;
      });
    }
    return rows;
  }, [enrichedStockData, sortConfig, searchQuery]);

  const requestSort = (key) => {
    setSortConfig(prev => ({ key, direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc' }));
  };

  // ─── Momentum bar chart data ──────────────────────────────────────
  const barChartData = useMemo(() => {
    const scored = enrichedStockData.filter(s => s.momentumScore != null);
    if (scored.length === 0) return { top: [], bottom: [] };
    const sorted = [...scored].sort((a, b) => b.momentumScore - a.momentumScore);
    const top = sorted.slice(0, 10).map(s => ({ name: s.symbol, score: s.momentumScore }));
    const bottom = sorted.slice(-10).reverse().map(s => ({ name: s.symbol, score: s.momentumScore }));
    return { top, bottom };
  }, [enrichedStockData]);

  // ─── Render helpers ───────────────────────────────────────────────
  const quadrantBadge = (q) => {
    const colors = { Leading: '#22c55e', Weakening: '#eab308', Lagging: '#ef4444', Improving: '#3b82f6' };
    const emojis = { Leading: '🟢', Weakening: '🟡', Lagging: '🔴', Improving: '🔵' };
    if (!q) return null;
    return (
      <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '0.2rem 0.5rem', borderRadius: '4px', border: `1px solid ${colors[q] || '#888'}`, color: colors[q] || '#888', background: `${colors[q]}15` || 'transparent' }}>
        {emojis[q]} {q}
      </span>
    );
  };

  const SmaCell = ({ v }) => {
    if (v === null || v === undefined) return <td style={{ padding: '0.4rem', textAlign: 'center', color: 'var(--text-secondary)' }}>–</td>;
    return <td style={{ padding: '0.4rem', textAlign: 'center', color: v ? '#22c55e' : '#ef4444' }}>{v ? '▲' : '▼'}</td>;
  };

  const Cell = ({ value }) => (
    <td style={{ padding: '0.4rem', color: pctColor(value), fontWeight: value != null ? 600 : 400, textAlign: 'right' }}>
      {fmtPct(value)}
    </td>
  );

  // ─── Tab content ──────────────────────────────────────────────────
  const renderOverview = () => (
    <div>
      {/* Momentum Bar Charts */}
      {(barChartData.top.length > 0 || barChartData.bottom.length > 0) && (
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          {[{ data: barChartData.top, title: 'Top 10 — Leaders', subtitle: 'Highest momentum score' },
            { data: barChartData.bottom, title: 'Bottom 10 — Laggards', subtitle: 'Lowest momentum score' }].map(({ data, title, subtitle }) => (
            <div key={title} className="glass-panel" style={{ padding: '1.5rem', flex: '1 1 380px' }}>
              <h3 style={{ margin: '0 0 0.2rem 0', fontSize: '1rem' }}>{title}</h3>
              <p style={{ margin: '0 0 0.75rem 0', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>{subtitle}</p>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data} layout="vertical" margin={{ left: 70, right: 20, top: 5, bottom: 5 }}>
                  <XAxis type="number" domain={[0, 100]} tick={{ fill: 'var(--text-secondary)', fontSize: 10 }} />
                  <YAxis dataKey="name" type="category" width={65} tick={{ fill: 'var(--text-primary)', fontSize: 11 }} />
                  <Tooltip
                    formatter={v => [v, 'Momentum Score']}
                    contentStyle={{ background: '#0f1117', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, fontSize: '0.82rem', color: '#fff', padding: '0.5rem 0.75rem' }}
                    labelStyle={{ color: '#fff', fontWeight: 700, marginBottom: '0.2rem' }}
                    itemStyle={{ color: '#94a3b8' }}
                    cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                  />
                  <Bar dataKey="score" radius={[0, 4, 4, 0]}>
                    {data.map((entry, i) => (
                      <RechartsCell key={i} fill={entry.score >= 60 ? '#22c55e' : entry.score >= 40 ? '#eab308' : '#ef4444'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ))}
        </div>
      )}

      {/* MA Breadth */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.6rem' }}>Moving Average Breadth</div>
        {!maGaugeData ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Loading SMA data…</p>
        ) : (
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <MaBreadthCard
              title="SMA-20" subtitle="Short-term trend"
              pct={maGaugeData.pct20}
              aboveNames={maGaugeData.above20names}
              belowNames={maGaugeData.below20names}
            />
            <MaBreadthCard
              title="SMA-200" subtitle="Long-term trend"
              pct={maGaugeData.pct200}
              aboveNames={maGaugeData.above200names}
              belowNames={maGaugeData.below200names}
            />
          </div>
        )}
      </div>
    </div>
  );

  const renderStocks = () => (
    <div className="glass-panel" style={{ padding: '1rem' }}>
      <div style={{ marginBottom: '1rem' }}>
        <input
          type="text"
          placeholder="Search stocks…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{ padding: '0.5rem 1rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-dark)', color: 'var(--text-primary)', width: '240px', fontSize: '0.9rem', outline: 'none' }}
        />
        <span style={{ marginLeft: '0.75rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {histLoadedCount}/{constituents.length} stocks loaded
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
              <th style={{ textAlign: 'left', padding: '0.5rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Name</th>
              <th style={{ textAlign: 'right', padding: '0.5rem', color: 'var(--text-secondary)' }}>Price</th>
              {['1D','1W','1M','3M','6M','1Y','3Y'].map(k => (
                <SortTh key={k} label={k} sortKey={k} sortConfig={sortConfig} onSort={requestSort} style={{ textAlign: 'right' }} />
              ))}
              <SortTh label="RSI" sortKey="rsi14" sortConfig={sortConfig} onSort={requestSort} style={{ textAlign: 'right' }} />
              <SortTh label="Score" sortKey="momentumScore" sortConfig={sortConfig} onSort={requestSort} style={{ textAlign: 'right' }} />
              <SortTh label="SMA 20" sortKey="aboveSma20" sortConfig={sortConfig} onSort={requestSort} style={{ textAlign: 'center' }} />
              <SortTh label="SMA 200" sortKey="aboveSma200" sortConfig={sortConfig} onSort={requestSort} style={{ textAlign: 'center' }} />
            </tr>
          </thead>
          <tbody>
            {sortedStocks.map((s, idx) => (
              <tr
                key={s.key}
                onClick={() => s.token && navigate(`/instrument/${s.token}?symbol=${s.symbol}`)}
                style={{ cursor: s.token ? 'pointer' : 'default', borderBottom: idx !== sortedStocks.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', transition: 'background 0.15s' }}
                onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                onMouseOut={e => e.currentTarget.style.background = 'transparent'}
              >
                <td style={{ padding: '0.4rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
                  <div>{s.name}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{s.symbol}</div>
                </td>
                <td style={{ padding: '0.4rem', textAlign: 'right', fontWeight: 600 }}>
                  {s.price ? `₹${s.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '–'}
                </td>
                <Cell value={s['1D']} />
                <Cell value={s['1W']} />
                <Cell value={s['1M']} />
                <Cell value={s['3M']} />
                <Cell value={s['6M']} />
                <Cell value={s['1Y']} />
                <Cell value={s['3Y']} />
                <td style={{ padding: '0.4rem', textAlign: 'right', color: s.rsi14 >= 70 ? '#ef4444' : s.rsi14 <= 30 ? '#22c55e' : 'var(--text-primary)' }}>
                  {s.rsi14 != null ? s.rsi14 : '–'}
                </td>
                <td style={{ padding: '0.4rem', textAlign: 'right', fontWeight: 700, color: s.momentumScore >= 60 ? '#22c55e' : s.momentumScore >= 40 ? '#eab308' : s.momentumScore != null ? '#ef4444' : 'var(--text-secondary)' }}>
                  {s.momentumScore != null ? s.momentumScore : '–'}
                </td>
                <SmaCell v={s.aboveSma20} />
                <SmaCell v={s.aboveSma200} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderHiddenLeaders = () => {
    if (!hiddenLeaders) return (
      <div className="glass-panel" style={{ padding: '1.5rem' }}>
        <p style={{ color: 'var(--text-secondary)' }}>Loading weekly candle data…</p>
      </div>
    );

    if (!hiddenLeaders.active) return (
      <div className="glass-panel" style={{ padding: '1.5rem', textAlign: 'center' }}>
        <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📈</div>
        <p style={{ color: '#22c55e', fontWeight: 600 }}>Sector is in an uptrend — no Lower High detected</p>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Hidden Leaders signal activates when the sector index makes a Lower High (recent 4-week high &lt; prior 4-week high).</p>
      </div>
    );

    const { leaders } = hiddenLeaders;

    if (leaders.length === 0) return (
      <div className="glass-panel" style={{ padding: '1.5rem', textAlign: 'center' }}>
        <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🔍</div>
        <p style={{ color: '#eab308', fontWeight: 600 }}>Sector making a Lower High</p>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>No individual stocks are making Higher Highs at this time.</p>
      </div>
    );

    return (
      <div className="glass-panel" style={{ padding: '1.5rem' }}>
        <h3 style={{ margin: '0 0 0.3rem 0', fontSize: '1rem' }}>Hidden Leaders ({leaders.length})</h3>
        <p style={{ margin: '0 0 1rem 0', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
          Sector is making Lower Highs — these stocks are making Higher Highs (relative strength divergence)
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                <th style={{ textAlign: 'left', padding: '0.5rem', color: 'var(--text-secondary)' }}>Name</th>
                <th style={{ textAlign: 'right', padding: '0.5rem', color: 'var(--text-secondary)' }}>1M Return</th>
                <th style={{ textAlign: 'right', padding: '0.5rem', color: 'var(--text-secondary)' }}>RS vs Sector</th>
                <th style={{ textAlign: 'right', padding: '0.5rem', color: 'var(--text-secondary)' }}>RS vs NIFTY 50</th>
                <th style={{ padding: '0.5rem' }}></th>
              </tr>
            </thead>
            <tbody>
              {leaders.sort((a, b) => (b.rsVsSector ?? -99) - (a.rsVsSector ?? -99)).map((s, idx) => (
                <tr
                  key={s.key}
                  onClick={() => s.token && navigate(`/instrument/${s.token}?symbol=${s.symbol}`)}
                  style={{ cursor: 'pointer', borderBottom: idx !== leaders.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', transition: 'background 0.15s' }}
                  onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                  onMouseOut={e => e.currentTarget.style.background = 'transparent'}
                >
                  <td style={{ padding: '0.5rem', fontWeight: 600 }}>
                    <div>{s.name}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{s.symbol}</div>
                  </td>
                  <Cell value={s['1M']} />
                  <Cell value={s.rsVsSector} />
                  <Cell value={s.rsVsNifty} />
                  <td style={{ padding: '0.5rem' }}>
                    <span style={{ fontSize: '0.65rem', fontWeight: 800, padding: '0.2rem 0.5rem', borderRadius: '4px', background: '#10b98130', color: '#10b981', border: '1px solid #10b98150', letterSpacing: '0.5px' }}>
                      HIDDEN LEADER
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  // ─── Loading / error ──────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <div className="loader" style={{ margin: '0 auto 1rem', width: '32px', height: '32px', borderWidth: '4px' }}></div>
        <p style={{ color: 'var(--text-secondary)' }}>Loading {sectorName}…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <p style={{ color: '#ef4444' }}>Error: {error}</p>
        <button onClick={() => navigate('/indices')} style={{ marginTop: '1rem', padding: '0.5rem 1rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
          ← Back to Indices
        </button>
      </div>
    );
  }

  const tabStyle = (tab) => ({
    padding: '0.5rem 1.25rem',
    borderRadius: '6px 6px 0 0',
    border: '1px solid',
    borderBottom: activeTab === tab ? 'none' : '1px solid var(--border)',
    background: activeTab === tab ? 'rgba(255,255,255,0.05)' : 'transparent',
    color: activeTab === tab ? 'var(--text-primary)' : 'var(--text-secondary)',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '0.85rem',
    borderColor: activeTab === tab ? 'var(--border)' : 'transparent',
    borderBottomColor: activeTab === tab ? 'transparent' : 'var(--border)',
    transition: 'all 0.15s',
  });

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1400px', margin: '0 auto' }}>
      {/* Breadcrumb */}
      <div style={{ marginBottom: '1rem', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
        <Link to="/indices" style={{ color: 'var(--accent)', textDecoration: 'none' }}>Indices Performance</Link>
        <span style={{ margin: '0 0.5rem' }}>›</span>
        <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{sectorName}</span>
      </div>

      {/* Header card */}
      <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1.25rem' }}>
        {/* Name + price */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, letterSpacing: '0.02em' }}>{sectorName}</h1>
          {sectorQuote && (
            <>
              <span style={{ fontSize: '1.25rem', fontWeight: 700 }}>
                ₹{sectorQuote.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
              </span>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: pctColor(sectorQuote.change1D) }}>
                {fmtPct(sectorQuote.change1D)}
              </span>
            </>
          )}
        </div>

        {/* Returns inline */}
        {sectorReturns && (
          <div style={{ display: 'flex', gap: '0.9rem', alignItems: 'baseline' }}>
            {['1W','1M','3M','6M','1Y'].map(k => (
              <div key={k} style={{ display: 'flex', alignItems: 'baseline', gap: '0.3rem' }}>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{k}</span>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: pctColor(sectorReturns[k]) }}>
                  {fmtPct(sectorReturns[k])}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Stats — pushed right */}
        <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'center', marginLeft: 'auto' }}>
          {inheritedScore != null && (() => {
            const c = inheritedScore >= 60 ? '#22c55e' : inheritedScore >= 40 ? '#eab308' : '#ef4444';
            return (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem' }}>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Momentum</span>
                <span style={{ fontSize: '0.9rem', fontWeight: 700, color: c }}>{inheritedScore}</span>
              </div>
            );
          })()}
          {inheritedQuadrant && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem' }}>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>RRG</span>
              {quadrantBadge(inheritedQuadrant)}
            </div>
          )}
          {sectorRsi14 != null && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem' }}>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>RSI</span>
              <span style={{ fontSize: '0.9rem', fontWeight: 700, color: sectorRsi14 >= 70 ? '#ef4444' : sectorRsi14 <= 30 ? '#22c55e' : 'var(--text-primary)' }}>
                {sectorRsi14}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0', marginBottom: '-1px', borderBottom: '1px solid var(--border)' }}>
        {[
          { id: 'overview', label: 'Overview' },
          { id: 'rrg', label: 'RRG' },
          { id: 'stocks', label: `Stocks (${constituents.length})` },
          { id: 'leaders', label: hiddenLeaders?.active ? `Hidden Leaders (${hiddenLeaders.leaders.length})` : 'Hidden Leaders' },
        ].map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={tabStyle(t.id)}>{t.label}</button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ paddingTop: '1rem' }}>
        {activeTab === 'overview' && renderOverview()}
        {activeTab === 'rrg' && (
          <RRGChart
            rrg={rrg}
            rrgLoading={rrgLoading}
            rrgBenchmark={rrgBenchmark}
            setRrgBenchmark={() => {}}
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
            benchmarkReadOnly={true}
          />
        )}
        {activeTab === 'stocks' && renderStocks()}
        {activeTab === 'leaders' && renderHiddenLeaders()}
      </div>
    </div>
  );
}
