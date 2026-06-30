import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ComposedChart, Area, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid, ReferenceLine, ReferenceDot,
  BarChart, Bar, Cell, LineChart, Line,
} from 'recharts';
import { breakoutRank, breakoutLabel } from '../../lib/breakout';
import { generateSignals } from '../../lib/signalEngine';
import SignalChart from '../../components/SignalChart';
import AnalystsPanel from '../../components/AnalystsPanel';

// US ETF/equity detail: company name, snapshot, price chart with MA overlays,
// RSI panel, a technical-signal strip, period stats, and a full indicator grid —
// all computed client-side from Alpaca bars.

const RANGES = ['1D', '1W', '1M', '3M', '6M', '1Y', '2Y', '3Y', '5Y'];

const fmtPrice = (v) => (v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtPct = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const pctColor = (v) => (v == null ? 'var(--text-secondary)' : v >= 0 ? 'var(--success)' : 'var(--danger)');
const GREEN = 'var(--success)', RED = 'var(--danger)', GREY = 'var(--text-secondary)';
const fmtBig = (n) => {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString('en-US')}`;
};
const fmtR = (n) => (n == null ? '—' : n.toFixed(2));
const pctF = (n) => (n == null ? '—' : `${n.toFixed(2)}%`);

// ─── Indicator math ─────────────────────────────────────────────
const sma = (vals, p) => {
  const out = Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) { sum += vals[i]; if (i >= p) sum -= vals[i - p]; if (i >= p - 1) out[i] = sum / p; }
  return out;
};
const emaFull = (vals, p) => {
  if (vals.length === 0) return [];
  const k = 2 / (p + 1);
  const out = [vals[0]];
  for (let i = 1; i < vals.length; i++) out.push(vals[i] * k + out[i - 1] * (1 - k));
  return out;
};
const rsiSeries = (vals, p = 14) => {
  const out = Array(vals.length).fill(null);
  if (vals.length < p + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = vals[i] - vals[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= p; l /= p;
  out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
    l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
};
const stddev = (vals, p) => {
  const out = Array(vals.length).fill(null);
  for (let i = p - 1; i < vals.length; i++) {
    const w = vals.slice(i - p + 1, i + 1);
    const m = w.reduce((a, b) => a + b, 0) / p;
    out[i] = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / p);
  }
  return out;
};
const lastNN = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };

const trueRanges = (bars) => bars.map((b, i) => i === 0 ? b.high - b.low
  : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)));

const atr14 = (bars, p = 14) => {
  if (bars.length < p + 1) return null;
  const tr = trueRanges(bars);
  let a = tr.slice(1, p + 1).reduce((s, v) => s + v, 0) / p;
  for (let i = p + 1; i < bars.length; i++) a = (a * (p - 1) + tr[i]) / p;
  return a;
};

const adx14 = (bars, p = 14) => {
  if (bars.length < 2 * p + 1) return null;
  const tr = [], pDM = [], mDM = [];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low - bars[i].low;
    pDM.push(up > dn && up > 0 ? up : 0);
    mDM.push(dn > up && dn > 0 ? dn : 0);
    const pc = bars[i - 1].close;
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc)));
  }
  const wilder = (arr) => { let s = arr.slice(0, p).reduce((a, b) => a + b, 0); const o = [s]; for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; o.push(s); } return o; };
  const trS = wilder(tr), pS = wilder(pDM), mS = wilder(mDM);
  const dx = [];
  for (let i = 0; i < trS.length; i++) {
    if (!trS[i]) { dx.push(0); continue; }
    const pdi = 100 * pS[i] / trS[i], mdi = 100 * mS[i] / trS[i];
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum);
  }
  if (dx.length < p) return null;
  let adx = dx.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < dx.length; i++) adx = (adx * (p - 1) + dx[i]) / p;
  return adx;
};

const superTrend = (bars, period = 10, mult = 3) => {
  if (bars.length < period + 2) return null;
  const tr = trueRanges(bars);
  const atr = Array(bars.length).fill(null);
  let a = tr.slice(1, period + 1).reduce((s, v) => s + v, 0) / period;
  atr[period] = a;
  for (let i = period + 1; i < bars.length; i++) { a = (a * (period - 1) + tr[i]) / period; atr[i] = a; }
  let dir = 1, fUpper = null, fLower = null, st = null;
  for (let i = period; i < bars.length; i++) {
    const hl2 = (bars[i].high + bars[i].low) / 2;
    const bu = hl2 + mult * atr[i], bl = hl2 - mult * atr[i];
    fUpper = (fUpper == null || bu < fUpper || bars[i - 1].close > fUpper) ? bu : fUpper;
    fLower = (fLower == null || bl > fLower || bars[i - 1].close < fLower) ? bl : fLower;
    if (st == null) { st = bl; dir = 1; }
    else if (dir === 1) { if (bars[i].close < fLower) { dir = -1; st = fUpper; } else st = fLower; }
    else { if (bars[i].close > fUpper) { dir = 1; st = fLower; } else st = fUpper; }
  }
  return { dir: dir === 1 ? 'up' : 'down', value: st };
};

// ─── Breakout engine + support/resistance (ported from the Indian Instrument) ──
const BREAKOUT_RSI_MIN = 55; // "strict momentum" gate

function computeSupportResistance(data) {
  if (!Array.isArray(data) || data.length < 20) return { supports: [], resistances: [] };
  const highs = data.map(d => d.high ?? d.close);
  const lows = data.map(d => d.low ?? d.close);
  const k = Math.min(10, Math.max(3, Math.round(data.length / 40)));
  const pivots = [];
  for (let i = k; i < data.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) { if (highs[j] > highs[i]) isHigh = false; if (lows[j] < lows[i]) isLow = false; }
    if (isHigh) pivots.push(highs[i]);
    if (isLow) pivots.push(lows[i]);
  }
  if (pivots.length === 0) return { supports: [], resistances: [] };
  pivots.sort((a, b) => a - b);
  const tol = 0.015;
  const clusters = [];
  for (const p of pivots) {
    const last = clusters[clusters.length - 1];
    const lastAvg = last ? last.sum / last.count : null;
    if (last && Math.abs(p - lastAvg) / lastAvg <= tol) { last.sum += p; last.count++; }
    else clusters.push({ sum: p, count: 1 });
  }
  const levels = clusters.map(c => ({ price: +(c.sum / c.count).toFixed(2), touches: c.count }));
  const price = data[data.length - 1].close;
  const minGap = 0.05;
  const scoreOf = (l) => {
    const dist = Math.abs(l.price - price) / price;
    const nearness = Math.max(0, 1 - dist / 0.6);
    const strength = Math.min(l.touches, 4) / 4;
    return 0.6 * nearness + 0.4 * strength;
  };
  const pickSide = (cands, descending) => {
    const ranked = [...cands].sort((a, b) => scoreOf(b) - scoreOf(a));
    const picked = [];
    for (const l of ranked) {
      if (picked.every(p => Math.abs(p.price - l.price) / price >= minGap)) picked.push(l);
      if (picked.length >= 4) break;
    }
    return picked.sort((a, b) => (descending ? b.price - a.price : a.price - b.price));
  };
  const supports = pickSide(levels.filter(l => l.price < price * 0.995), true);
  const resistances = pickSide(levels.filter(l => l.price > price * 1.005), false);
  return { supports, resistances };
}

function detectBreakoutsAdvanced(data, { volMult = 1.5, confirmPeriods = 3, strictMomentum = false, lookback = 30 } = {}) {
  const n = data.length;
  if (n < lookback + 2) return [];
  const highs = data.map(d => d.high ?? d.close);
  const closes = data.map(d => d.close);
  const vols = data.map(d => d.volume ?? 0);
  const hasVolume = vols.some(v => v > 0);
  const rsi = rsiSeries(closes, 14);
  const VOL_P = 20;
  const volSMA = (i) => { if (i < VOL_P) return null; let s = 0; for (let j = i - VOL_P; j < i; j++) s += vols[j]; return s / VOL_P; };
  const maxBefore = (end) => { let m = -Infinity; for (let j = Math.max(0, end - lookback); j < end; j++) if (highs[j] > m) m = highs[j]; return m; };
  const cooldown = Math.max(3, Math.round(lookback / 3));
  const out = [];
  let last = -Infinity;
  for (let i = lookback; i < n; i++) {
    const level = maxBefore(i);
    if (!(closes[i] > level && closes[i - 1] <= maxBefore(i - 1))) continue;
    if (i - last < cooldown) continue;
    let volX = null;
    if (hasVolume) { const vsma = volSMA(i); volX = vsma ? vols[i] / vsma : null; if (volX == null || volX < volMult) continue; }
    const r = rsi[i];
    if (strictMomentum && !(r != null && r >= BREAKOUT_RSI_MIN)) continue;
    let failedAt = null;
    const avail = Math.min(confirmPeriods, n - 1 - i);
    for (let kk = 1; kk <= avail; kk++) { if (closes[i + kk] < level) { failedAt = kk; break; } }
    const status = failedAt != null ? 'failed' : (avail >= confirmPeriods ? 'confirmed' : 'pending');
    out.push({
      index: i, date: data[i].date, price: closes[i], level: +level.toFixed(2), status,
      volX: volX != null ? +volX.toFixed(2) : null,
      rsi: r != null ? Math.round(r) : null,
      heldPeriods: failedAt != null ? failedAt - 1 : avail, confirmPeriods,
    });
    last = i;
  }
  return out;
}

function srStrength(touches) {
  if (touches >= 3) return { width: 2, opacity: 0.95, tag: 1 };
  if (touches === 2) return { width: 1.5, opacity: 0.8, tag: 0.85 };
  return { width: 1, opacity: 0.5, tag: 0.6 };
}
function srPriceTag(price, color, opacity = 1) {
  return function SRTag({ viewBox }) {
    const { x, y, width } = viewBox;
    const text = `$${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    const w = text.length * 6.6 + 16;
    const lx = x + width + 6;
    return (
      <g opacity={opacity}>
        <rect x={lx} y={y - 9} width={w} height={18} rx={4} fill="#0f172a" stroke={color} strokeWidth={1} fillOpacity={0.95} />
        <text x={lx + w / 2} y={y + 1} dominantBaseline="middle" textAnchor="middle" fill="#ffffff" fontSize={11} fontWeight={700}>{text}</text>
      </g>
    );
  };
}

const cls = (text, color) => ({ text, color });
const maCls = (price, ma) => ma == null ? cls('—', GREY) : price >= ma ? cls('BULLISH', GREEN) : cls('BEARISH', RED);
const rsiCls = (r) => r == null ? cls('—', GREY)
  : r >= 70 ? cls('BEARISH (OVERBOUGHT)', RED)
  : r <= 30 ? cls('BULLISH (OVERSOLD)', GREEN)
  : cls('NEUTRAL', GREY);

function IndicatorCard({ label, value, cls }) {
  return (
    <div className="glass-panel" style={{ padding: '0.9rem 1.1rem' }}>
      <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: GREY }}>{label}</div>
      <div style={{ fontSize: '1.3rem', fontWeight: 700, margin: '0.25rem 0', color: cls?.color === RED ? RED : cls?.color === GREEN ? GREEN : 'var(--text-primary)' }}>{value}</div>
      {cls && <div style={{ fontSize: '0.72rem', fontWeight: 600, color: cls.color, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{cls.text}</div>}
    </div>
  );
}

function StatCard({ label, value, sub, subColor }) {
  return (
    <div className="glass-panel" style={{ padding: '1.25rem 1.5rem', flex: '1', minWidth: '200px' }}>
      <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: GREY }}>{label}</div>
      <div style={{ fontSize: '1.6rem', fontWeight: 700, marginTop: '0.3rem' }}>{value}</div>
      {sub && <div style={{ fontSize: '0.8rem', fontWeight: 600, marginTop: '0.2rem', color: subColor || GREY }}>{sub}</div>}
    </div>
  );
}

function FundRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '0.5rem 0.9rem', borderBottom: '1px solid var(--border)', fontSize: '0.85rem' }}>
      <span style={{ color: GREY }}>{label}</span>
      <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}
function FundGroup({ title, rows }) {
  return (
    <div className="glass-panel" style={{ padding: '0 0 0.25rem' }}>
      <div style={{ padding: '0.6rem 0.9rem', fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--accent)', borderBottom: '1px solid var(--border)' }}>{title}</div>
      {rows.map(r => <FundRow key={r.label} label={r.label} value={r.value} />)}
    </div>
  );
}
function Fundamentals({ sym }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let on = true; setLoading(true); setErr(null);
    fetch(`/api/us/fundamentals/${sym}`).then(r => r.json())
      .then(j => { if (!on) return; if (j.error) setErr(j.error); else setD(j); })
      .catch(e => on && setErr(e.message)).finally(() => on && setLoading(false));
    return () => { on = false; };
  }, [sym]);

  if (loading) return <div className="loader" />;
  if (err) return <div className="glass-panel" style={{ padding: '1.5rem', color: RED }}>Failed to load fundamentals: {err}</div>;
  if (!d) return null;
  const { valuation: v, profitability: p, growth: g, financials: f, dividend: dv, analyst: an, price: pr } = d;
  return (
    <div>
      <div className="glass-panel" style={{ padding: '1.25rem 1.5rem', marginBottom: '1.25rem' }}>
        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
          <strong>{d.sector || (d.quoteType === 'ETF' ? 'ETF' : '—')}</strong>
          {d.industry && <span style={{ color: GREY }}>· {d.industry}</span>}
          {d.country && <span style={{ color: GREY, fontSize: '0.8rem' }}>· {d.country}</span>}
          {d.employees && <span style={{ color: GREY, fontSize: '0.8rem' }}>· {d.employees.toLocaleString('en-US')} employees</span>}
          {d.website && <a href={d.website} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontSize: '0.8rem' }}>{d.website.replace(/^https?:\/\//, '')}</a>}
        </div>
        {d.summary && <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', lineHeight: 1.6, margin: '0.75rem 0 0' }}>{d.summary}</p>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
        <FundGroup title="Size & Price" rows={[
          { label: 'Market Cap', value: fmtBig(pr.marketCap) },
          { label: 'Shares Outstanding', value: pr.sharesOut != null ? fmtBig(pr.sharesOut).replace('$', '') : '—' },
          { label: 'Beta', value: fmtR(pr.beta) },
          { label: '52-Week High', value: pr.week52High != null ? `$${fmtPrice(pr.week52High)}` : '—' },
          { label: '52-Week Low', value: pr.week52Low != null ? `$${fmtPrice(pr.week52Low)}` : '—' },
          { label: 'Avg Volume', value: pr.avgVolume != null ? pr.avgVolume.toLocaleString('en-US') : '—' },
        ]} />
        <FundGroup title="Valuation" rows={[
          { label: 'Trailing P/E', value: fmtR(v.trailingPE) },
          { label: 'Forward P/E', value: fmtR(v.forwardPE) },
          { label: 'PEG Ratio', value: fmtR(v.pegRatio) },
          { label: 'Price / Book', value: fmtR(v.priceToBook) },
          { label: 'Price / Sales', value: fmtR(v.priceToSales) },
          { label: 'EV / EBITDA', value: fmtR(v.evToEbitda) },
          { label: 'EV / Revenue', value: fmtR(v.evToRevenue) },
        ]} />
        <FundGroup title="Profitability" rows={[
          { label: 'Return on Equity', value: pctF(p.roe) },
          { label: 'Return on Assets', value: pctF(p.roa) },
          { label: 'Gross Margin', value: pctF(p.grossMargin) },
          { label: 'Operating Margin', value: pctF(p.operatingMargin) },
          { label: 'Profit Margin', value: pctF(p.profitMargin) },
        ]} />
        <FundGroup title="Growth (YoY)" rows={[
          { label: 'Revenue Growth', value: pctF(g.revenue) },
          { label: 'Earnings Growth', value: pctF(g.earnings) },
        ]} />
        <FundGroup title="Financials (TTM)" rows={[
          { label: 'Total Revenue', value: fmtBig(f.totalRevenue) },
          { label: 'EBITDA', value: fmtBig(f.ebitda) },
          { label: 'Gross Profit', value: fmtBig(f.grossProfits) },
          { label: 'Free Cash Flow', value: fmtBig(f.freeCashflow) },
          { label: 'Total Cash', value: fmtBig(f.totalCash) },
          { label: 'Total Debt', value: fmtBig(f.totalDebt) },
          { label: 'Debt / Equity', value: fmtR(f.debtToEquity) },
          { label: 'Current Ratio', value: fmtR(f.currentRatio) },
        ]} />
        <FundGroup title="Earnings & Dividend" rows={[
          { label: 'EPS (TTM)', value: d.eps.trailing != null ? `$${fmtPrice(d.eps.trailing)}` : '—' },
          { label: 'EPS (Forward)', value: d.eps.forward != null ? `$${fmtPrice(d.eps.forward)}` : '—' },
          { label: 'Dividend Yield', value: pctF(dv.yield) },
          { label: 'Dividend Rate', value: dv.rate != null ? `$${fmtPrice(dv.rate)}` : '—' },
          { label: 'Payout Ratio', value: pctF(dv.payoutRatio) },
        ]} />
        <FundGroup title="Analyst" rows={[
          { label: 'Recommendation', value: an.recommendation ? an.recommendation.toUpperCase() : '—' },
          { label: 'Target Mean', value: an.targetMean != null ? `$${fmtPrice(an.targetMean)}` : '—' },
          { label: 'Target High', value: an.targetHigh != null ? `$${fmtPrice(an.targetHigh)}` : '—' },
          { label: 'Target Low', value: an.targetLow != null ? `$${fmtPrice(an.targetLow)}` : '—' },
          { label: '# Analysts', value: an.analysts != null ? an.analysts : '—' },
        ]} />
      </div>
      <p style={{ fontSize: '0.7rem', color: GREY, marginTop: '1rem', fontStyle: 'italic' }}>
        Fundamentals via Yahoo Finance{d.cached ? ' · cached' : ''}. ETFs report limited fundamentals.
      </p>
    </div>
  );
}

function PnL({ sym }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('annual');
  useEffect(() => {
    let on = true; setLoading(true); setErr(null);
    fetch(`/api/us/pnl/${sym}`).then(r => r.json())
      .then(j => { if (!on) return; if (j.error) setErr(j.error); else setD(j); })
      .catch(e => on && setErr(e.message)).finally(() => on && setLoading(false));
    return () => { on = false; };
  }, [sym]);
  if (loading) return <div className="loader" />;
  if (err) return <div className="glass-panel" style={{ padding: '1.5rem', color: RED }}>Failed to load P&amp;L: {err}</div>;
  if (!d) return null;
  const rows = period === 'annual' ? d.annual : d.quarterly;
  if (!rows || rows.length === 0) return <div className="glass-panel" style={{ padding: '1.5rem', color: GREY }}>No income-statement data available (ETFs report none).</div>;

  const metrics = [
    { key: 'revenue', label: 'Revenue', money: true, growth: true, bold: true },
    { key: 'costOfRevenue', label: 'Cost of Revenue', money: true },
    { key: 'grossProfit', label: 'Gross Profit', money: true },
    { key: 'operatingExpense', label: 'Operating Expense', money: true },
    { key: 'operatingIncome', label: 'Operating Income', money: true, growth: true },
    { key: 'pretaxIncome', label: 'Pretax Income', money: true },
    { key: 'tax', label: 'Tax', money: true },
    { key: 'netIncome', label: 'Net Income', money: true, growth: true, bold: true },
    { key: 'eps', label: 'EPS (Diluted)', eps: true, growth: true },
    { key: 'grossMargin', label: 'Gross Margin', pct: true },
    { key: 'operatingMargin', label: 'Operating Margin', pct: true },
    { key: 'netMargin', label: 'Net Margin', pct: true },
  ];
  const fmtCell = (m, v) => v == null ? '—' : m.pct ? pctF(v) : m.eps ? `$${v.toFixed(2)}` : fmtBig(v);
  const yoy = (i, key) => { if (i === 0) return null; const c = rows[i][key], p = rows[i - 1][key]; if (c == null || p == null || p === 0) return null; return ((c - p) / Math.abs(p)) * 100; };
  const th = { textAlign: 'right', padding: '0.55rem 0.8rem', color: GREY, whiteSpace: 'nowrap', fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.03em' };
  const stickyBg = { position: 'sticky', left: 0, background: 'var(--bg-panel, #0f172a)' };

  return (
    <div>
      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem' }}>
        {[['annual', 'Annual'], ['quarterly', 'Quarterly']].map(([p, lbl]) => (
          <button key={p} onClick={() => setPeriod(p)} style={{
            padding: '0.35rem 0.9rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.82rem',
            border: '1px solid var(--border)', fontWeight: 600,
            background: period === p ? 'var(--accent)' : 'transparent', color: period === p ? '#fff' : GREY,
          }}>{lbl}</button>
        ))}
      </div>
      <div className="glass-panel" style={{ padding: '0.4rem', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left', ...stickyBg }}>Metric</th>
              {rows.map(r => <th key={r.label} style={th}>{r.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {metrics.map(m => (
              <tr key={m.key} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ textAlign: 'left', padding: '0.5rem 0.8rem', color: 'var(--text-secondary)', fontWeight: m.bold ? 700 : 400, ...stickyBg }}>{m.label}</td>
                {rows.map((r, i) => {
                  const g = m.growth ? yoy(i, m.key) : null;
                  return (
                    <td key={i} style={{ textAlign: 'right', padding: '0.5rem 0.8rem', fontWeight: m.bold ? 700 : 500, fontVariantNumeric: 'tabular-nums' }}>
                      {fmtCell(m, r[m.key])}
                      {g != null && <div style={{ fontSize: '0.68rem', fontWeight: 600, color: g >= 0 ? GREEN : RED }}>{g >= 0 ? '+' : ''}{g.toFixed(1)}%</div>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: '0.7rem', color: GREY, marginTop: '0.75rem', fontStyle: 'italic' }}>
        Income statement via Yahoo Finance{d.cached ? ' · cached' : ''}. Values in {d.currency}; growth is period-over-period.
      </p>
    </div>
  );
}

// ─── Balance Sheet tab ──────────────────────────────────────────────────────
// Annual asset / liability & equity line items from Yahoo, presented in the same
// snapshot-box + grouped-table format as the Indian Instrument page (USD, $).
const BS_ROWS = [
  { key: 'cash',                label: 'Cash & Investments',     group: 'asset' },
  { key: 'receivables',         label: 'Receivables',            group: 'asset' },
  { key: 'inventory',           label: 'Inventory',              group: 'asset' },
  { key: 'currentAssets',       label: 'Total Current Assets',   group: 'asset', emphasis: true },
  { key: 'netPPE',              label: 'Net PP&E',               group: 'asset' },
  { key: 'intangibles',         label: 'Goodwill & Intangibles', group: 'asset' },
  { key: 'longTermInvestments', label: 'Long-Term Investments',  group: 'asset' },
  { key: 'totalAssets',         label: 'Total Assets',           group: 'asset', emphasis: true },
  { key: 'payables',            label: 'Accounts Payable',       group: 'liab' },
  { key: 'currentLiabilities',  label: 'Total Current Liabilities', group: 'liab', emphasis: true },
  { key: 'longTermDebt',        label: 'Long-Term Debt',         group: 'liab' },
  { key: 'totalLiabilities',    label: 'Total Liabilities',      group: 'liab', emphasis: true },
  // Redeemable/convertible preferred carried outside equity (mezzanine). Only
  // shows for names that have it — typically pre-IPO years; auto-hidden otherwise.
  { key: 'redeemablePreferred', label: 'Redeemable Preferred',   group: 'liab' },
  { key: 'retainedEarnings',    label: 'Retained Earnings',      group: 'liab' },
  { key: 'equity',              label: "Shareholders' Equity",   group: 'liab', emphasis: true },
];

function BalanceSheet({ sym }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let on = true; setLoading(true); setErr(null);
    fetch(`/api/us/balance-sheet/${sym}`).then(r => r.json())
      .then(j => { if (!on) return; if (j.error) setErr(j.error); else setD(j); })
      .catch(e => on && setErr(e.message)).finally(() => on && setLoading(false));
    return () => { on = false; };
  }, [sym]);

  if (loading) return <div className="loader" />;
  if (err) return <div className="glass-panel" style={{ padding: '1.5rem', color: RED }}>Failed to load balance sheet: {err}</div>;

  const years = Array.isArray(d?.years) ? d.years : [];
  const hasAny = (key) => years.some(y => y[key] != null);
  const visibleRows = BS_ROWS.filter(r => hasAny(r.key));
  const trendColor = (v, band = 0) => v == null ? GREY : Math.abs(v) <= band ? GREY : v > 0 ? '#10b981' : '#ef4444';
  const arrow = (v, band = 0) => v == null ? '·' : Math.abs(v) <= band ? '→' : v > 0 ? '↑' : '↓';
  const yoy = (curr, prev) => (curr == null || prev == null || prev === 0) ? null : ((curr - prev) / Math.abs(prev)) * 100;

  // Balance-sheet snapshot — pure arithmetic over the multi-year series.
  const snap = (() => {
    if (years.length < 2) return null;
    const latest = years[years.length - 1], prior = years[years.length - 2];
    const debt = latest.totalDebt ?? latest.longTermDebt ?? null;
    const debtPrior = prior.totalDebt ?? prior.longTermDebt ?? null;
    const de = (debt != null && latest.equity != null && latest.equity !== 0) ? debt / latest.equity : null;
    const debtYoY = (debt != null && debtPrior != null && debtPrior !== 0) ? ((debt - debtPrior) / Math.abs(debtPrior)) * 100 : null;
    const currentRatio = (latest.currentAssets != null && latest.currentLiabilities) ? latest.currentAssets / latest.currentLiabilities : null;
    const assetsYoY = yoy(latest.totalAssets, prior.totalAssets);
    // Equity CAGR — both endpoints must be positive (CAGR undefined across zero).
    const eqValid = years.filter(y => y.equity != null);
    const e0 = eqValid[0], e1 = eqValid[eqValid.length - 1];
    let eqCAGR = null, eqTurnedNeg = false;
    if (e0 && e1 && e0.equity > 0 && e1.equity > 0 && e1.fy > e0.fy) {
      eqCAGR = { val: (Math.pow(e1.equity / e0.equity, 1 / (e1.fy - e0.fy)) - 1) * 100, from: e0.fyLabel, to: e1.fyLabel };
    } else if (e0 && e1 && e0.equity > 0 && e1.equity <= 0) eqTurnedNeg = true;
    const flags = [];
    if (latest.equity != null && latest.equity < 0) flags.push(`Negative shareholders' equity of ${fmtBig(Math.abs(latest.equity))} — solvency risk`);
    if (de != null && de > 2) flags.push(`High leverage — D/E of ${de.toFixed(2)}× (debt ${fmtBig(debt)} vs equity ${fmtBig(latest.equity)})`);
    // Only flag a debt spike when the debt is material (≥ 5% of assets) — a big
    // % jump on a trivial balance (e.g. $1M → $4M of leases) isn't noteworthy.
    if (debtYoY != null && debtYoY > 30 && debt != null && latest.totalAssets && debt / latest.totalAssets >= 0.05) {
      flags.push(`Total debt jumped +${debtYoY.toFixed(0)}% in ${latest.fyLabel}`);
    }
    if (currentRatio != null && currentRatio < 1) flags.push(`Current ratio ${currentRatio.toFixed(2)}× — current liabilities exceed current assets`);
    const debtMaterial = debt != null && latest.totalAssets ? debt / latest.totalAssets >= 0.05 : false;
    return { latest, de, debt, debtYoY, debtMaterial, currentRatio, assetsYoY, eqCAGR, eqTurnedNeg, flags };
  })();

  const th = { textAlign: 'right', padding: '0.6rem 0.8rem', color: GREY, whiteSpace: 'nowrap', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: '1px solid var(--border)' };
  const stickyBg = (emph) => ({ position: 'sticky', left: 0, background: emph ? 'rgba(56,189,248,0.06)' : 'var(--bg-panel, #0f172a)', zIndex: 1 });
  const metricLabel = { fontSize: '0.7rem', color: GREY, textTransform: 'uppercase', letterSpacing: '0.5px' };

  return (
    <section className="glass-panel" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div>
          <h2 style={{ margin: 0 }}>Balance Sheet</h2>
          <span style={{ fontSize: '0.75rem', color: GREY }}>Annual · Yahoo Finance (USD){d?.cached ? ' · cached' : ''}</span>
        </div>
        {years.length > 0 && (
          <span style={{ fontSize: '0.7rem', color: GREY, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            {years[0].fyLabel} → {years[years.length - 1].fyLabel}
          </span>
        )}
      </div>

      {years.length === 0 ? (
        <p style={{ textAlign: 'center', color: GREY }}>
          {d == null ? 'Loading…' : 'Balance sheet data is not available for this instrument (ETFs report none).'}
        </p>
      ) : (
        <>
          {/* Snapshot */}
          {snap && (
            <div style={{ marginBottom: '1.25rem', padding: '1rem 1.1rem', borderRadius: '10px', background: 'rgba(56,189,248,0.04)', border: '1px solid rgba(56,189,248,0.18)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Balance Sheet Snapshot</span>
                {snap.latest?.fyLabel && <span style={{ fontSize: '0.7rem', color: GREY }}>· latest {snap.latest.fyLabel}</span>}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem' }}>
                <div>
                  <div style={metricLabel}>Debt-to-Equity</div>
                  <div style={{ fontSize: '1.05rem', fontWeight: 700, marginTop: '0.2rem', color: snap.de == null ? GREY : snap.de > 2 ? '#ef4444' : snap.de > 1 ? '#f59e0b' : '#10b981' }}>
                    {snap.de == null ? '—' : `${snap.de.toFixed(2)}×`}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: GREY, marginTop: '0.15rem' }}>
                    {snap.debt != null && snap.latest.equity != null ? `${fmtBig(snap.debt)} debt / ${fmtBig(snap.latest.equity)} equity` : 'Insufficient data'}
                  </div>
                </div>
                <div>
                  <div style={metricLabel}>Equity CAGR</div>
                  <div style={{ fontSize: '1.05rem', fontWeight: 700, marginTop: '0.2rem', color: snap.eqTurnedNeg ? '#ef4444' : trendColor(snap.eqCAGR?.val, 0.5) }}>
                    {snap.eqTurnedNeg ? '↓ n/a' : snap.eqCAGR == null ? '—' : `${arrow(snap.eqCAGR.val, 0.5)} ${snap.eqCAGR.val >= 0 ? '+' : ''}${snap.eqCAGR.val.toFixed(1)}% /yr`}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: GREY, marginTop: '0.15rem' }}>
                    {snap.eqTurnedNeg ? `Turned negative by ${snap.latest.fyLabel}` : snap.eqCAGR != null ? `${snap.eqCAGR.from} → ${snap.eqCAGR.to}` : 'Needs ≥ 2 years'}
                  </div>
                </div>
                <div>
                  <div style={metricLabel}>Current Ratio</div>
                  <div style={{ fontSize: '1.05rem', fontWeight: 700, marginTop: '0.2rem', color: snap.currentRatio == null ? GREY : snap.currentRatio < 1 ? '#ef4444' : snap.currentRatio < 1.5 ? '#f59e0b' : '#10b981' }}>
                    {snap.currentRatio == null ? '—' : `${snap.currentRatio.toFixed(2)}×`}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: GREY, marginTop: '0.15rem' }}>
                    {snap.currentRatio == null ? 'Insufficient data' : snap.currentRatio < 1 ? 'Liquidity watch' : 'Covers current liabilities'}
                  </div>
                </div>
                <div>
                  <div style={metricLabel}>Total Assets YoY</div>
                  <div style={{ fontSize: '1.05rem', fontWeight: 700, marginTop: '0.2rem', color: trendColor(snap.assetsYoY, 0.5) }}>
                    {arrow(snap.assetsYoY, 0.5)} {snap.assetsYoY == null ? '—' : `${snap.assetsYoY >= 0 ? '+' : ''}${snap.assetsYoY.toFixed(1)}%`}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: GREY, marginTop: '0.15rem' }}>
                    {snap.debtYoY == null || !snap.debtMaterial ? 'Balance sheet trend' : `Total debt ${snap.debtYoY >= 0 ? '+' : ''}${snap.debtYoY.toFixed(0)}% YoY`}
                  </div>
                </div>
              </div>
              {snap.flags.length > 0 && (
                <div style={{ marginTop: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  {snap.flags.map((f, i) => (
                    <div key={i} style={{ fontSize: '0.75rem', color: '#fca5a5', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.22)', padding: '0.3rem 0.55rem', borderRadius: '6px' }}>⚠ {f}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Data table */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '0.9rem' }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'left', ...stickyBg(false) }}>Metric</th>
                  {years.map(y => <th key={y.sortKey} style={th}>{y.fyLabel}</th>)}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map(row => (
                  <tr key={row.key} style={row.emphasis ? { background: 'rgba(56,189,248,0.04)' } : undefined}>
                    <td style={{ textAlign: 'left', padding: '0.7rem 0.8rem', color: 'var(--text-primary)', fontWeight: row.emphasis ? 700 : 500, borderBottom: '1px solid rgba(255,255,255,0.04)', ...stickyBg(row.emphasis) }}>{row.label}</td>
                    {years.map((y, i) => {
                      const v = y[row.key];
                      const prev = i > 0 ? years[i - 1][row.key] : null;
                      const delta = row.emphasis ? yoy(v, prev) : null;
                      return (
                        <td key={y.sortKey} style={{ textAlign: 'right', padding: '0.7rem 0.8rem', whiteSpace: 'nowrap', fontWeight: row.emphasis ? 700 : 500, fontVariantNumeric: 'tabular-nums', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                          <div style={{ color: v != null && v < 0 ? '#ef4444' : 'var(--text-primary)' }}>{v == null ? '—' : fmtBig(v)}</div>
                          {delta != null && <div style={{ fontSize: '0.7rem', fontWeight: 500, color: delta >= 0 ? '#10b981' : '#ef4444' }}>{delta >= 0 ? '+' : ''}{delta.toFixed(1)}%</div>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: '0.7rem', color: GREY, marginTop: '0.75rem', marginBottom: 0, fontStyle: 'italic' }}>
              Source: Yahoo Finance (annual, USD). Total Liabilities (+ Redeemable Preferred, when present) + Shareholders' Equity = Total Assets. Redeemable/convertible preferred is mezzanine equity, shown separately rather than counted as debt. Selected key line items are shown — "other" current/non-current items are omitted, so the listed rows need not sum to the bold subtotals (those come straight from the filing). YoY shown on totals. Empty cells (—) weren't disclosed for that year.
            </p>
          </div>
        </>
      )}
    </section>
  );
}

// ─── Cashflow tab ───────────────────────────────────────────────────────────
// Annual CFO/CFI/CFF + derived Net & Free Cash Flow from Yahoo, presented in
// the same Chart/Table format as the Indian Instrument page (USD, $).
const CF_SERIES = [
  { key: 'operatingCashFlow', label: 'Operating (CFO)', color: 'var(--accent)',          chart: true,  help: 'Cash generated by core business operations — the engine of the business.' },
  { key: 'investingCashFlow', label: 'Investing (CFI)', color: '#a29bfe',                chart: true,  help: 'Cash spent on / received from investments (capex, acquisitions, asset sales). Negative is normal for a growing company.' },
  { key: 'financingCashFlow', label: 'Financing (CFF)', color: 'var(--danger)',          chart: true,  help: 'Cash from / returned to financiers (debt, equity, dividends, buybacks). Negative = returning cash to investors.' },
  { key: 'netCashFlow',       label: 'Net Cash Flow',   color: 'var(--text-secondary)', chart: false, help: 'CFO + CFI + CFF — the net change in cash for the year.' },
  { key: 'freeCashFlow',      label: 'Free Cash Flow',  color: 'var(--success)',         chart: true,  help: 'CFO minus capex — discretionary cash for dividends, buybacks, or debt paydown.' },
];

function Cashflow({ sym }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('chart'); // 'chart' | 'table'
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    let on = true; setLoading(true); setErr(null);
    fetch(`/api/us/cashflow/${sym}`).then(r => r.json())
      .then(j => { if (!on) return; if (j.error) setErr(j.error); else setD(j); })
      .catch(e => on && setErr(e.message)).finally(() => on && setLoading(false));
    return () => { on = false; };
  }, [sym]);
  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setHelpOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [helpOpen]);

  if (loading) return <div className="loader" />;
  if (err) return <div className="glass-panel" style={{ padding: '1.5rem', color: RED }}>Failed to load cashflow: {err}</div>;

  const years = Array.isArray(d?.years) ? d.years : [];
  const visible = years.slice(-8); // older years get unreadable

  const cfColor = (v) => v == null ? GREY : v > 0 ? '#10b981' : v < 0 ? '#ef4444' : 'var(--text-primary)';
  const growthPill = (curr, prev) => {
    if (curr == null || prev == null || prev === 0) return null;
    const pct = ((curr - prev) / Math.abs(prev)) * 100;
    const positive = pct >= 0;
    const abs = Math.abs(pct);
    let color;
    if (abs < 5) color = positive ? '#34d399' : '#fca5a5';
    else if (abs < 15) color = positive ? '#10b981' : '#ef4444';
    else color = positive ? '#059669' : '#dc2626';
    return { label: `${positive ? '↑' : '↓'}${abs.toFixed(1)}%`, color, weight: abs >= 15 ? 800 : 700 };
  };
  const trendColor = (v, band = 0) => v == null ? GREY : Math.abs(v) <= band ? GREY : v > 0 ? '#10b981' : '#ef4444';
  const arrow = (v, band = 0) => v == null ? '·' : Math.abs(v) <= band ? '→' : v > 0 ? '↑' : '↓';
  const Sparkline = ({ points }) => {
    const valid = points.filter(p => p.v != null);
    if (valid.length < 2) return <span style={{ color: GREY, fontSize: '0.7rem' }}>—</span>;
    const rising = valid[valid.length - 1].v >= valid[0].v;
    const color = rising ? '#10b981' : '#ef4444';
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

  // Cashflow-quality snapshot — pure arithmetic over the full series.
  const snap = (() => {
    if (years.length < 2) return null;
    const n = years.length;
    const latest = years[n - 1], earliest = years[0];
    const fcfPos = years.filter(y => (y.freeCashFlow ?? 0) > 0).length;
    const capexCov = years.filter(y => y.operatingCashFlow != null && y.investingCashFlow != null && (y.operatingCashFlow + y.investingCashFlow) >= 0).length;
    const cfoTrendPct = (earliest.operatingCashFlow != null && earliest.operatingCashFlow !== 0 && latest.operatingCashFlow != null)
      ? ((latest.operatingCashFlow - earliest.operatingCashFlow) / Math.abs(earliest.operatingCashFlow)) * 100 : null;
    let caution = null;
    if ((latest.operatingCashFlow ?? 0) < 0) caution = `Operating cash flow was negative in ${latest.fyLabel}`;
    else if ((latest.freeCashFlow ?? 0) < 0) caution = `Free cash flow was negative in ${latest.fyLabel}`;
    return { n, fcfPos, capexCov, cfoTrendPct, range: `${earliest.fyLabel}–${latest.fyLabel}`, caution };
  })();

  const empty = visible.length === 0;
  const cardStyle = { flex: '1 1 160px', padding: '0.85rem 1rem', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid var(--border)' };
  const cardLabel = { fontSize: '0.65rem', color: GREY, textTransform: 'uppercase', letterSpacing: '0.5px' };

  return (
    <>
      <section className="glass-panel" style={{ padding: '1.5rem' }}>
        {/* Header + Chart/Table toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <h2 style={{ margin: 0 }}>Cashflow Analysis</h2>
            <span style={{ fontSize: '0.75rem', color: GREY }}>Annual cashflow statement · Yahoo Finance (USD)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button onClick={() => setHelpOpen(true)} title="What do these cash-flow terms mean?"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', background: 'transparent', border: '1px solid var(--border)', borderRadius: '8px', color: GREY, padding: '0.35rem 0.7rem', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600 }}>
              <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '15px', height: '15px', borderRadius: '50%', border: '1px solid currentColor', fontSize: '0.62rem', fontWeight: 800, lineHeight: 1 }}>?</span>
              Legend
            </button>
            <div role="tablist" aria-label="Cashflow view" style={{ display: 'inline-flex', borderRadius: '8px', border: '1px solid var(--border)', overflow: 'hidden' }}>
              {[['chart', 'Chart'], ['table', 'Table']].map(([key, label]) => {
                const active = view === key;
                return (
                  <button key={key} role="tab" aria-selected={active} onClick={() => setView(key)}
                    style={{ background: active ? 'var(--accent)' : 'transparent', color: active ? '#04141f' : GREY, border: 'none', padding: '0.35rem 0.9rem', cursor: 'pointer', fontSize: '0.78rem', fontWeight: active ? 700 : 500, transition: 'all 0.15s' }}>
                    {label}
                  </button>
                );
              })}
            </div>
            {visible.length > 0 && (
              <span style={{ fontSize: '0.7rem', color: GREY, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {visible[0].fyLabel} → {visible[visible.length - 1].fyLabel}
              </span>
            )}
          </div>
        </div>

        {empty ? (
          <p style={{ textAlign: 'center', color: GREY }}>
            {d == null ? 'Loading…' : 'Cashflow data is not available for this instrument (ETFs report none).'}
          </p>
        ) : view === 'chart' ? (
          <div style={{ height: '360px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={visible} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="fyLabel" stroke="var(--text-secondary)" />
                <YAxis stroke="var(--text-secondary)" tickFormatter={(val) => fmtBig(val)} width={70} />
                <Tooltip contentStyle={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                  formatter={(value, name) => [value == null ? '—' : fmtBig(value), name]}
                  labelFormatter={(label) => `Fiscal Year ${String(label).replace('FY ', '')}`} />
                <Legend />
                {CF_SERIES.filter(s => s.chart).map(s => (
                  <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <>
            {/* Quality snapshot */}
            {snap && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.25rem' }}>
                <div style={cardStyle}>
                  <div style={cardLabel}>FCF Track Record</div>
                  <div style={{ fontSize: '1.05rem', fontWeight: 700, color: trendColor(snap.fcfPos * 2 - snap.n), marginTop: '0.2rem' }}>{snap.fcfPos} / {snap.n} yrs</div>
                  <div style={{ fontSize: '0.7rem', color: GREY }}>Free cash flow positive</div>
                </div>
                <div style={cardStyle}>
                  <div style={cardLabel}>CFO Trend</div>
                  <div style={{ fontSize: '1.05rem', fontWeight: 700, color: trendColor(snap.cfoTrendPct, 1), marginTop: '0.2rem' }}>
                    {arrow(snap.cfoTrendPct, 1)} {snap.cfoTrendPct == null ? '—' : `${snap.cfoTrendPct >= 0 ? '+' : ''}${snap.cfoTrendPct.toFixed(0)}%`}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: GREY }}>Operating cash · {snap.range}</div>
                </div>
                <div style={cardStyle}>
                  <div style={cardLabel}>Capex Coverage</div>
                  <div style={{ fontSize: '1.05rem', fontWeight: 700, color: trendColor(snap.capexCov * 2 - snap.n), marginTop: '0.2rem' }}>{snap.capexCov} / {snap.n} yrs</div>
                  <div style={{ fontSize: '0.7rem', color: GREY }}>CFO covered investing</div>
                </div>
              </div>
            )}
            {snap?.caution && (
              <div style={{ marginBottom: '1rem', padding: '0.6rem 0.9rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '8px', fontSize: '0.78rem', color: '#fca5a5' }}>
                ⚠ {snap.caution}
              </div>
            )}

            {/* Data table */}
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '0.9rem' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '0.65rem 0.75rem', color: GREY, fontWeight: 600, fontSize: '0.72rem', letterSpacing: '0.5px', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>Cash Flow</th>
                    {visible.map(col => (
                      <th key={col.fyLabel} style={{ textAlign: 'right', padding: '0.65rem 0.75rem', color: GREY, fontWeight: 600, fontSize: '0.72rem', letterSpacing: '0.5px', borderBottom: '1px solid var(--border)' }}>{col.fyLabel}</th>
                    ))}
                    <th style={{ textAlign: 'right', padding: '0.65rem 0.75rem', color: GREY, fontWeight: 600, fontSize: '0.72rem', letterSpacing: '0.5px', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {CF_SERIES.map(s => {
                    const sparkPoints = visible.map(y => ({ v: y[s.key] ?? null }));
                    return (
                      <tr key={s.key}>
                        <td style={{ textAlign: 'left', padding: '0.85rem 0.75rem', color: 'var(--text-primary)', fontWeight: 600, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                          <span style={{ display: 'inline-block', width: '9px', height: '9px', borderRadius: '2px', background: s.color, marginRight: '0.5rem', border: s.key === 'netCashFlow' ? '1px solid var(--text-secondary)' : 'none' }} />
                          {s.label}
                        </td>
                        {visible.map((col, idx) => {
                          const value = col[s.key] ?? null;
                          const prev = idx > 0 ? (visible[idx - 1][s.key] ?? null) : null;
                          const pill = growthPill(value, prev);
                          return (
                            <td key={col.fyLabel} style={{ textAlign: 'right', padding: '0.85rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.04)', verticalAlign: 'top' }}>
                              <div style={{ color: cfColor(value), fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value == null ? '—' : fmtBig(value)}</div>
                              <div style={{ marginTop: '0.2rem', fontSize: '0.7rem', textAlign: 'right' }}>
                                {pill ? (
                                  <span title="Year-on-Year" style={{ color: pill.color, fontWeight: pill.weight }}>
                                    <span style={{ color: GREY, fontWeight: 500, marginRight: '3px' }}>YoY</span>{pill.label}
                                  </span>
                                ) : (
                                  <span style={{ color: GREY }}>YoY —</span>
                                )}
                              </div>
                            </td>
                          );
                        })}
                        <td style={{ textAlign: 'right', padding: '0.85rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                          <div style={{ display: 'inline-block' }}><Sparkline points={sparkPoints} /></div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div style={{ marginTop: '0.75rem', fontSize: '0.7rem', color: GREY, fontStyle: 'italic' }}>
                Source: Yahoo Finance (annual, USD){d.cached ? ' · cached' : ''}. Net = CFO + CFI + CFF. Free Cash Flow = CFO − capex.
              </div>
            </div>
          </>
        )}
      </section>

      {/* Legend help modal — sibling of the glass-panel so the fixed overlay isn't trapped by its backdrop-filter. */}
      {helpOpen && (
        <div className="conv-modal-backdrop" onClick={() => setHelpOpen(false)}>
          <div className="conv-modal" style={{ width: '560px', maxWidth: '100%' }} onClick={(e) => e.stopPropagation()}>
            <div className="conv-modal-header">
              <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Cashflow legend</h2>
              <button className="conv-modal-close" onClick={() => setHelpOpen(false)} aria-label="Close">✕</button>
            </div>
            <div className="conv-modal-body">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {CF_SERIES.map(s => (
                  <div key={s.key} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem' }}>
                    <span style={{ width: '12px', height: '12px', borderRadius: '3px', background: s.color, marginTop: '3px', flexShrink: 0, border: s.key === 'netCashFlow' ? '1px solid var(--text-secondary)' : 'none' }} />
                    <span style={{ fontSize: '0.82rem', color: GREY, lineHeight: 1.5 }}>
                      <strong style={{ color: 'var(--text-primary)' }}>{s.label}</strong> — {s.help}
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border)', fontSize: '0.72rem', color: GREY, fontStyle: 'italic' }}>
                Net = CFO + CFI + CFF · Free Cash Flow = CFO − capex · Annual (USD).
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Analyst coverage tab — shared panel, USD formatting ────────────────────
const usMoney = (v) => (v == null ? '—' : `$${fmtPrice(v)}`);
function Analysts({ sym }) {
  return (
    <AnalystsPanel
      fetchUrl={`/api/us/analysts/${sym}`}
      money={usMoney}
      bigMoney={fmtBig}
      emptyNote="No analyst coverage available (typical for ETFs and small/foreign listings)."
    />
  );
}

export default function UsInstrument() {
  const { symbol } = useParams();
  const sym = (symbol || '').toUpperCase();
  const [snap, setSnap] = useState(null);
  const [bars, setBars] = useState([]);
  const [dailyBars, setDailyBars] = useState([]); // 1Y+ daily for stable indicators
  const [range, setRange] = useState('6M');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('technicals');
  // Breakout engine + S/R controls
  const [volMult, setVolMult] = useState(1.5);
  const [confirmPeriods, setConfirmPeriods] = useState(3);
  const [strictMomentum, setStrictMomentum] = useState(false);
  const [showBreakouts, setShowBreakouts] = useState(true);
  const [showSR, setShowSR] = useState(true);
  const [showSignals, setShowSignals] = useState(false); // 10/50 MA-crossover Buy/Sell markers (off by default)

  const loadSnap = useCallback(async () => {
    try { const r = await fetch(`/api/us/snapshot/${sym}`); const j = await r.json(); if (r.ok) setSnap(j); } catch { /* */ }
  }, [sym]);
  const loadBars = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/us/bars/${sym}?range=${range}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setBars(j.bars || []); setError(null);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }, [sym, range]);
  const loadDaily = useCallback(async () => {
    try { const r = await fetch(`/api/us/bars/${sym}?range=2Y`); const j = await r.json(); if (r.ok) setDailyBars(j.bars || []); } catch { /* */ }
  }, [sym]);

  useEffect(() => { loadSnap(); }, [loadSnap]);
  useEffect(() => { loadBars(); }, [loadBars]);
  useEffect(() => { loadDaily(); }, [loadDaily]);

  const q = snap?.quote || {};
  const companyName = snap?.name || snap?.meta?.label || sym;
  const intraday = range === '1D';

  // Support/resistance + breakout markers on the visible candles (skip intraday).
  const sr = useMemo(() => intraday ? { supports: [], resistances: [] } : computeSupportResistance(bars), [bars, intraday]);
  const breakouts = useMemo(() => {
    if (intraday) return [];
    const lb = Math.min(45, Math.max(15, Math.round(bars.length / 18)));
    return detectBreakoutsAdvanced(bars, { volMult, confirmPeriods, strictMomentum, lookback: lb });
  }, [bars, intraday, volMult, confirmPeriods, strictMomentum]);

  // 10/50 SMA crossover Buy/Sell signals. Compute on the DEEP series (the 2Y
  // dailyBars already loaded for indicators) so the 50-SMA is warm even on a 3M
  // view, then keep only signals whose bar is in the visible window — matched by
  // date, which is identical across both daily series. Falls back to `bars` when
  // it's the longer series (3Y/4Y views).
  const maSignals = useMemo(() => {
    if (intraday || bars.length === 0) return [];
    const src = dailyBars.length > bars.length ? dailyBars : bars;
    if (src.length <= 50) return [];
    const visible = new Set(bars.map(b => b.date));
    return generateSignals(src, 10, 50).signals.filter(s => visible.has(s.bar.date));
  }, [dailyBars, bars, intraday]);
  const nConfirmed = breakouts.filter(b => b.status === 'confirmed').length;
  const nFailed = breakouts.filter(b => b.status === 'failed').length;
  const nPending = breakouts.filter(b => b.status === 'pending').length;
  const hasVolume = bars.some(d => d.volume > 0);

  // Period stats from the visible range.
  const period = useMemo(() => {
    if (bars.length === 0) return null;
    const high = Math.max(...bars.map(b => b.high));
    const low = Math.min(...bars.map(b => b.low));
    const last = bars[bars.length - 1].close;
    // For the 1D (intraday) view, measure the return from the previous close so
    // it matches the headline daily change; other ranges compare first→last bar.
    const base = intraday && q.prevClose != null ? q.prevClose : bars[0].close;
    const ret = base ? ((last - base) / base) * 100 : null;
    const retAbs = last - base;
    return { high, low, ret, retAbs };
  }, [bars, intraday, q.prevClose]);

  // Full indicator suite from the stable daily series.
  const ind = useMemo(() => {
    const closes = dailyBars.map(b => b.close);
    if (closes.length < 15) return null;
    const price = closes[closes.length - 1];
    const ema12 = emaFull(closes, 12), ema26 = emaFull(closes, 26);
    const macdLine = closes.map((_, i) => ema12[i] - ema26[i]);
    const signalArr = emaFull(macdLine, 9);
    const macd = macdLine[macdLine.length - 1], signal = signalArr[signalArr.length - 1];
    const mid = lastNN(sma(closes, 20));
    const sd = lastNN(stddev(closes, 20));
    const v = {
      price,
      rsi: lastNN(rsiSeries(closes, 14)),
      sma5: lastNN(sma(closes, 5)), sma20: lastNN(sma(closes, 20)),
      sma50: lastNN(sma(closes, 50)), sma200: lastNN(sma(closes, 200)),
      ema12: lastNN(ema12), ema26: lastNN(ema26),
      macd, signal, hist: macd - signal,
      bbMid: mid, bbUpper: mid != null && sd != null ? mid + 2 * sd : null, bbLower: mid != null && sd != null ? mid - 2 * sd : null,
      atr: atr14(dailyBars, 14), adx: adx14(dailyBars, 14), st: superTrend(dailyBars, 10, 3),
      breakout: breakoutRank(dailyBars),
    };
    // Directional bias across the trend-following indicators.
    const checks = [
      v.sma5, v.sma20, v.sma50, v.sma200, v.ema12, v.ema26, v.bbMid,
    ].map(m => m != null && price >= m);
    checks.push(v.macd > 0, v.macd >= v.signal, v.hist >= 0);
    const bull = checks.filter(Boolean).length;
    v.biasPct = Math.round((bull / checks.length) * 100);
    // Trend label from SMA alignment.
    if (v.sma20 && v.sma50 && v.sma200 && price > v.sma20 && v.sma20 > v.sma50 && v.sma50 > v.sma200) v.trend = cls('STRONG UPTREND', GREEN);
    else if (v.sma20 && v.sma50 && v.sma200 && price < v.sma20 && v.sma20 < v.sma50 && v.sma50 < v.sma200) v.trend = cls('DOWNTREND', RED);
    else if (v.sma50 && price > v.sma50) v.trend = cls('UPTREND', GREEN);
    else v.trend = cls('SIDEWAYS', GREY);
    v.vs200 = v.sma200 ? ((price - v.sma200) / v.sma200) * 100 : null;
    return v;
  }, [dailyBars]);

  const fmtAxis = (d) => {
    const dt = new Date(d);
    return intraday ? dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const up = (q.changePct ?? 0) >= 0;
  const chartColor = up ? '#22c55e' : '#ef4444';
  const bo = ind ? breakoutLabel(ind.breakout) : null;

  return (
    <div style={{ padding: '0.5rem 0' }}>
      <Link to="/us" style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: '0.85rem' }}>← US Markets</Link>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem', margin: '0.75rem 0 1.25rem', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{companyName}</h2>
        <span style={{ color: GREY, fontWeight: 600 }}>{sym}</span>
        {snap?.meta?.proxyFor && <span style={{ fontSize: '0.8rem', color: GREY }}>· {snap.meta.proxyFor}</span>}
      </div>

      {/* Price header */}
      <div className="glass-panel" style={{ padding: '1.25rem 1.5rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '2rem', fontWeight: 700 }}>${fmtPrice(q.last)}</span>
          <span style={{ color: pctColor(q.changePct), fontWeight: 600, fontSize: '1.1rem' }}>
            {q.change != null ? `${q.change >= 0 ? '+' : ''}$${fmtPrice(q.change)}` : '—'} ({fmtPct(q.changePct)})
          </span>
        </div>
        <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.75rem', fontSize: '0.8rem', color: GREY, flexWrap: 'wrap' }}>
          <span>Open ${fmtPrice(q.open)}</span><span>High ${fmtPrice(q.high)}</span><span>Low ${fmtPrice(q.low)}</span>
          <span>Prev close ${fmtPrice(q.prevClose)}</span>
          <span>Vol {q.volume != null ? q.volume.toLocaleString('en-US') : '—'}</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '1px solid var(--border)', marginBottom: '1.5rem' }}>
        {[{ id: 'technicals', label: 'Technicals' }, { id: 'signals', label: 'Signals' }, { id: 'fundamentals', label: 'Fundamentals' }, { id: 'analysts', label: 'Analysts' }, { id: 'pnl', label: 'P&L' }, { id: 'balanceSheet', label: 'Balance Sheet' }, { id: 'cashflow', label: 'Cashflow' }].map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            padding: '0.6rem 1.1rem', cursor: 'pointer', background: 'transparent', border: 'none',
            borderBottom: `2px solid ${activeTab === t.id ? 'var(--accent)' : 'transparent'}`,
            color: activeTab === t.id ? 'var(--text-primary)' : GREY, fontWeight: activeTab === t.id ? 700 : 500,
            fontSize: '0.95rem', marginBottom: '-1px',
          }}>{t.label}</button>
        ))}
      </div>

      {activeTab === 'fundamentals' && <Fundamentals sym={sym} />}

      {activeTab === 'analysts' && <Analysts sym={sym} />}

      {activeTab === 'pnl' && <PnL sym={sym} />}

      {activeTab === 'balanceSheet' && <BalanceSheet sym={sym} />}

      {activeTab === 'cashflow' && <Cashflow sym={sym} />}

      {activeTab === 'signals' && (
        <div className="glass-panel" style={{ padding: '1rem' }}>
          <SignalChart token={sym} symbol={sym} fetchUrl={`/api/us/historical-full/${sym}`} />
        </div>
      )}

      {activeTab === 'technicals' && (<>
      {/* Technical signal strip */}
      {ind && (
        <div className="glass-panel" style={{ padding: '1.1rem 1.5rem', marginBottom: '1.5rem' }}>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.15rem' }}>Technical Snapshot</div>
          <div style={{ fontSize: '0.72rem', color: GREY, marginBottom: '1rem' }}>Signal stack · trend, RSI, ADX, SuperTrend, breakout (daily)</div>
          <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '0.7rem', color: GREY, textTransform: 'uppercase' }}>Bias</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 800, color: ind.biasPct >= 50 ? GREEN : RED }}>{ind.biasPct}%</div>
              <div style={{ fontSize: '0.7rem', fontWeight: 600, color: ind.biasPct >= 50 ? GREEN : RED }}>{ind.biasPct >= 50 ? 'BULLISH' : 'BEARISH'}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', color: GREY, textTransform: 'uppercase' }}>Trend</div>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: ind.trend.color, marginTop: '0.35rem' }}>{ind.trend.text}</div>
              <div style={{ fontSize: '0.7rem', color: GREY }}>vs 200D {fmtPct(ind.vs200)}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', color: GREY, textTransform: 'uppercase' }}>RSI (14)</div>
              <div style={{ fontSize: '1.2rem', fontWeight: 700, color: rsiCls(ind.rsi).color, marginTop: '0.2rem' }}>{ind.rsi != null ? ind.rsi.toFixed(1) : '—'}</div>
              <div style={{ fontSize: '0.7rem', fontWeight: 600, color: rsiCls(ind.rsi).color }}>{rsiCls(ind.rsi).text}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', color: GREY, textTransform: 'uppercase' }}>ADX (14)</div>
              <div style={{ fontSize: '1.2rem', fontWeight: 700, marginTop: '0.2rem' }}>{ind.adx != null ? ind.adx.toFixed(1) : '—'}</div>
              <div style={{ fontSize: '0.7rem', fontWeight: 600, color: ind.adx >= 25 ? GREEN : GREY }}>{ind.adx == null ? '' : ind.adx >= 25 ? 'TRENDING' : 'WEAK TREND'}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', color: GREY, textTransform: 'uppercase' }}>SuperTrend</div>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: ind.st?.dir === 'up' ? GREEN : RED, marginTop: '0.35rem' }}>{ind.st ? (ind.st.dir === 'up' ? '▲ BULLISH' : '▼ BEARISH') : '—'}</div>
              <div style={{ fontSize: '0.7rem', color: GREY }}>{ind.st ? `$${fmtPrice(ind.st.value)}` : ''}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', color: GREY, textTransform: 'uppercase' }}>Breakout</div>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: bo?.color, marginTop: '0.35rem' }}>{bo?.text}</div>
              <div style={{ fontSize: '0.7rem', color: GREY }}>new-high reach</div>
            </div>
          </div>
        </div>
      )}

      {/* Period stats */}
      {period && (
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
          <StatCard label={`Period High (${range})`} value={`$${fmtPrice(period.high)}`} />
          <StatCard label={`Period Low (${range})`} value={`$${fmtPrice(period.low)}`} />
          <StatCard
            label={`Period Return (${range})`}
            value={<span style={{ color: pctColor(period.ret) }}>{fmtPct(period.ret)}</span>}
            sub={period.retAbs != null ? `${period.retAbs >= 0 ? '+' : ''}$${fmtPrice(period.retAbs)}` : ''}
            subColor={pctColor(period.ret)}
          />
        </div>
      )}

      {/* Range selector + chart overlay toggles */}
      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {RANGES.map(r => (
          <button key={r} onClick={() => setRange(r)} style={{
            padding: '0.35rem 0.8rem', borderRadius: '6px', cursor: 'pointer',
            border: '1px solid var(--border)', fontWeight: 600, fontSize: '0.8rem',
            background: range === r ? 'var(--accent)' : 'transparent', color: range === r ? '#fff' : GREY,
          }}>{r}</button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.4rem' }}>
          <button onClick={() => setShowBreakouts(v => !v)} style={{
            padding: '0.35rem 0.8rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem',
            background: showBreakouts ? 'rgba(234,179,8,0.12)' : 'transparent',
            color: showBreakouts ? '#eab308' : GREY, border: `1px solid ${showBreakouts ? '#eab308' : 'var(--border)'}`,
            fontWeight: showBreakouts ? 700 : 400,
          }}>▲ Breakouts</button>
          <button onClick={() => setShowSR(v => !v)} style={{
            padding: '0.35rem 0.8rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem',
            background: showSR ? 'rgba(56,189,248,0.12)' : 'transparent',
            color: showSR ? 'var(--accent)' : GREY, border: `1px solid ${showSR ? 'var(--accent)' : 'var(--border)'}`,
            fontWeight: showSR ? 700 : 400,
          }}>S/R Levels</button>
          <button onClick={() => setShowSignals(v => !v)}
            title="Toggle 10/50 SMA crossover Buy/Sell signals (golden/death cross with RSI filter)"
            style={{
            padding: '0.35rem 0.8rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem',
            background: showSignals ? 'rgba(34,197,94,0.14)' : 'transparent',
            color: showSignals ? '#22c55e' : GREY, border: `1px solid ${showSignals ? '#22c55e' : 'var(--border)'}`,
            fontWeight: showSignals ? 700 : 400,
          }}>▲▼ Signals (10/50)</button>
        </div>
      </div>

      {/* Breakout engine control panel */}
      {showBreakouts && !intraday && !loading && !error && bars.length > 0 && (
        <div className="glass-panel" style={{ display: 'flex', gap: '1.75rem', alignItems: 'center', flexWrap: 'wrap', padding: '0.85rem 1.1rem', marginBottom: '0.75rem' }}>
          <span title="Flags breakouts — price closing above its recent ceiling (highest high of the last ~30–45 bars) — then grades each as a real move or a trap."
            style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '1px', color: GREY, textTransform: 'uppercase', cursor: 'help' }}>
            Breakout Engine ⓘ
          </span>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', minWidth: '170px', opacity: hasVolume ? 1 : 0.5 }}>
            <span style={{ fontSize: '0.72rem', color: GREY }}>
              Volume ≥ <strong style={{ color: 'var(--accent)' }}>{volMult.toFixed(1)}×</strong> 20-bar avg
            </span>
            <input type="range" min="1" max="3" step="0.1" value={volMult} disabled={!hasVolume} onChange={e => setVolMult(+e.target.value)} style={{ accentColor: '#38bdf8', cursor: hasVolume ? 'pointer' : 'not-allowed' }} />
            {!hasVolume && <span style={{ fontSize: '0.65rem', color: '#fbbf24' }}>No volume — filter off</span>}
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', minWidth: '170px' }}>
            <span style={{ fontSize: '0.72rem', color: GREY }}>
              Confirm over <strong style={{ color: 'var(--accent)' }}>{confirmPeriods}</strong> {confirmPeriods === 1 ? 'period' : 'periods'}
            </span>
            <input type="range" min="1" max="5" step="1" value={confirmPeriods} onChange={e => setConfirmPeriods(+e.target.value)} style={{ accentColor: '#38bdf8', cursor: 'pointer' }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.78rem', color: GREY }}>
            <input type="checkbox" checked={strictMomentum} onChange={e => setStrictMomentum(e.target.checked)} style={{ accentColor: '#38bdf8', cursor: 'pointer', width: '15px', height: '15px' }} />
            Strict momentum <span style={{ opacity: 0.7 }}>(RSI ≥ {BREAKOUT_RSI_MIN})</span>
          </label>
          <span style={{ marginLeft: 'auto', fontSize: '0.78rem', fontWeight: 700, display: 'flex', gap: '0.75rem' }}>
            <span style={{ color: '#22c55e' }}>▲ {nConfirmed} confirmed</span>
            <span style={{ color: '#ef4444' }}>▼ {nFailed} failed</span>
            {nPending > 0 && <span style={{ color: '#fbbf24' }}>◆ {nPending} pending</span>}
          </span>
        </div>
      )}

      {/* Chart */}
      <div className="glass-panel" style={{ padding: '1rem', marginBottom: '1.5rem' }}>
        {loading ? <div className="loader" />
          : error ? <div style={{ color: RED, padding: '1rem' }}>Failed to load chart: {error}</div>
          : bars.length === 0 ? <div style={{ color: GREY, padding: '1rem' }}>No data for this range.</div>
          : (
            <>
              <div style={{ height: '440px' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={bars} margin={{ top: 10, right: showSR ? 74 : 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="usFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={chartColor} stopOpacity={0.35} />
                        <stop offset="100%" stopColor={chartColor} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={fmtAxis} tick={{ fill: GREY, fontSize: 11 }} minTickGap={40} />
                    <YAxis domain={['auto', 'auto']} tick={{ fill: GREY, fontSize: 11 }} width={55} tickFormatter={(v) => v.toFixed(0)} />
                    <Tooltip contentStyle={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '8px' }}
                      labelFormatter={(d) => new Date(d).toLocaleString('en-US')}
                      formatter={(v, name) => [`$${fmtPrice(v)}`, name === 'close' ? 'Price' : name.toUpperCase()]} />
                    <Legend />
                    {showSR && sr.supports.map(l => {
                      const st = srStrength(l.touches);
                      return <ReferenceLine key={`sup-${l.price}`} y={l.price} stroke="#f87171" strokeDasharray="2 4" strokeWidth={st.width} strokeOpacity={st.opacity} ifOverflow="extendDomain" label={srPriceTag(l.price, '#f87171', st.tag)} />;
                    })}
                    {showSR && sr.resistances.map(l => {
                      const st = srStrength(l.touches);
                      return <ReferenceLine key={`res-${l.price}`} y={l.price} stroke="#4ade80" strokeDasharray="2 4" strokeWidth={st.width} strokeOpacity={st.opacity} ifOverflow="extendDomain" label={srPriceTag(l.price, '#4ade80', st.tag)} />;
                    })}
                    {showBreakouts && breakouts.map((b) => {
                      const isFail = b.status === 'failed';
                      const isPending = b.status === 'pending';
                      const c = isFail ? '#ef4444' : isPending ? '#fbbf24' : '#22c55e';
                      const tip = `${b.status.toUpperCase()} breakout @ $${b.price}\nResistance: $${b.level}\n`
                        + `Volume: ${b.volX != null ? b.volX + '×' : '—'} avg · RSI: ${b.rsi ?? '—'}\n`
                        + `Held for: ${b.heldPeriods} / ${b.confirmPeriods} period${b.confirmPeriods === 1 ? '' : 's'}`;
                      return (
                        <ReferenceDot key={`bo-${b.index}`} x={b.date} y={b.price} ifOverflow="extendDomain"
                          shape={({ cx, cy }) => (
                            <g style={{ cursor: 'pointer' }}>
                              <title>{tip}</title>
                              {isFail
                                ? <path d={`M ${cx} ${cy - 7} L ${cx - 7} ${cy - 19} L ${cx + 7} ${cy - 19} Z`} fill={c} stroke="#0f172a" strokeWidth={1} />
                                : <path d={`M ${cx} ${cy - 19} L ${cx - 7} ${cy - 7} L ${cx + 7} ${cy - 7} Z`} fill={c} stroke="#0f172a" strokeWidth={1} />}
                            </g>
                          )}
                          label={isFail ? { value: 'Breakout - failed', position: 'top', fill: c, fontSize: 10, fontWeight: 700 } : undefined}
                        />
                      );
                    })}
                    {showSignals && maSignals.map((s) => {
                      const buy = s.type === 'buy';
                      if (buy && s.deadCat) return null; // dead-cat bounce: not an actionable buy
                      const c = buy ? '#22c55e' : '#ef4444';
                      const tip = `${buy ? 'BUY' : 'SELL'} · 10/50 ${buy ? 'golden' : 'death'} cross\n`
                        + `Fast(10) ${buy ? 'crossed above' : 'crossed below'} Slow(50)\n`
                        + `RSI ${s.rsi.toFixed(1)} · $${s.bar.close}`;
                      return (
                        <ReferenceDot key={`sig-${s.index}`} x={s.bar.date} y={s.bar.close} ifOverflow="extendDomain"
                          shape={({ cx, cy }) => (
                            <g style={{ cursor: 'pointer' }}>
                              <title>{tip}</title>
                              {/* "Long" below the bar for buys, "Short" above for sells. */}
                              <text
                                x={cx}
                                y={buy ? cy + 20 : cy - 11}
                                textAnchor="middle"
                                fontSize={11}
                                fontWeight={700}
                                fill={c}
                                stroke="#0f172a"
                                strokeWidth={0.7}
                                paintOrder="stroke"
                              >
                                {buy ? 'Long' : 'Short'}
                              </text>
                            </g>
                          )}
                        />
                      );
                    })}
                    <Area type="monotone" name="Price" dataKey="close" stroke={chartColor} strokeWidth={2} fill="url(#usFill)" isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
      </div>

      {/* Chart marker legend */}
      {!loading && !error && bars.length > 0 && !intraday && (showBreakouts || showSR || showSignals) && (
        <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'center', padding: '0.5rem 0.25rem 1.25rem', fontSize: '0.72rem', color: GREY }}>
          {showSignals && (<>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}><strong style={{ color: '#22c55e' }}>Long</strong> (10/50 golden cross, RSI &gt; 50)</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}><strong style={{ color: '#ef4444' }}>Short</strong> (10/50 death cross, RSI &lt; 50)</span>
          </>)}
          {showBreakouts && (<>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}><span style={{ color: '#22c55e' }}>▲</span> Confirmed breakout (held)</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}><span style={{ color: '#ef4444' }}>▼</span> Failed breakout (trap)</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}><span style={{ color: '#fbbf24' }}>◆</span> Pending (too recent)</span>
          </>)}
          {showSR && (<>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}><span style={{ color: '#f87171', letterSpacing: '-1px' }}>┈</span> Support</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}><span style={{ color: '#4ade80', letterSpacing: '-1px' }}>┈</span> Resistance</span>
            <span style={{ opacity: 0.8 }}>(brighter line = more tested)</span>
          </>)}
          <span style={{ marginLeft: 'auto', fontStyle: 'italic', opacity: 0.8 }}>Hover any marker for its volume, RSI &amp; hold details</span>
        </div>
      )}

      {/* Technical indicators grid */}
      {ind && (
        <>
          <h3 style={{ margin: '0 0 0.75rem' }}>Technical Indicators <span style={{ fontSize: '0.8rem', color: GREY, fontWeight: 400 }}>(daily timeframe)</span></h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '0.75rem' }}>
            <IndicatorCard label="RSI (14)" value={ind.rsi != null ? ind.rsi.toFixed(2) : '—'} cls={rsiCls(ind.rsi)} />
            <IndicatorCard label="SMA 5" value={`$${fmtPrice(ind.sma5)}`} cls={maCls(ind.price, ind.sma5)} />
            <IndicatorCard label="SMA 20" value={`$${fmtPrice(ind.sma20)}`} cls={maCls(ind.price, ind.sma20)} />
            <IndicatorCard label="SMA 50" value={`$${fmtPrice(ind.sma50)}`} cls={maCls(ind.price, ind.sma50)} />
            <IndicatorCard label="SMA 200" value={`$${fmtPrice(ind.sma200)}`} cls={maCls(ind.price, ind.sma200)} />
            <IndicatorCard label="EMA 12" value={`$${fmtPrice(ind.ema12)}`} cls={maCls(ind.price, ind.ema12)} />
            <IndicatorCard label="EMA 26" value={`$${fmtPrice(ind.ema26)}`} cls={maCls(ind.price, ind.ema26)} />
            <IndicatorCard label="MACD Line" value={ind.macd != null ? ind.macd.toFixed(2) : '—'} cls={ind.macd >= 0 ? cls('BULLISH', GREEN) : cls('BEARISH', RED)} />
            <IndicatorCard label="MACD Signal" value={ind.signal != null ? ind.signal.toFixed(2) : '—'} cls={ind.macd >= ind.signal ? cls('BULLISH', GREEN) : cls('BEARISH', RED)} />
            <IndicatorCard label="MACD Histogram" value={ind.hist != null ? ind.hist.toFixed(2) : '—'} cls={ind.hist >= 0 ? cls('BULLISH', GREEN) : cls('BEARISH', RED)} />
            <IndicatorCard label="ADX (14)" value={ind.adx != null ? ind.adx.toFixed(1) : '—'} cls={ind.adx >= 25 ? cls('TRENDING', GREEN) : cls('WEAK', GREY)} />
            <IndicatorCard label="ATR (14)" value={`$${fmtPrice(ind.atr)}`} cls={null} />
            <IndicatorCard label="BB Upper" value={`$${fmtPrice(ind.bbUpper)}`} cls={cls('NEUTRAL', GREY)} />
            <IndicatorCard label="BB Middle" value={`$${fmtPrice(ind.bbMid)}`} cls={maCls(ind.price, ind.bbMid)} />
            <IndicatorCard label="BB Lower" value={`$${fmtPrice(ind.bbLower)}`} cls={cls('NEUTRAL', GREY)} />
          </div>
        </>
      )}
      </>)}
    </div>
  );
}
