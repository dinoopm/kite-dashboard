import { useState, useEffect } from 'react';
import { fmtDate } from '../lib/formatDate';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

// Shared analyst-coverage panel used by both the US and Indian instrument pages.
// All currency rendering is delegated to the `money` (prices / EPS) and
// `bigMoney` (revenue) props so the same UI serves $ and ₹. The data shape is
// the common one returned by /api/us/analysts and /api/analysts.

const GREEN = 'var(--success)', RED = 'var(--danger)', GREY = 'var(--text-secondary)';
const fmtPct = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const pctColor = (v) => (v == null ? GREY : v >= 0 ? GREEN : RED);

// Rating buckets, deepest-green (most bullish) → red (most bearish).
const REC_BUCKETS = [
  { key: 'strongBuy', label: 'Strong Buy', color: '#15803d' },
  { key: 'buy', label: 'Buy', color: '#22c55e' },
  { key: 'hold', label: 'Hold', color: '#eab308' },
  { key: 'sell', label: 'Sell', color: '#f97316' },
  { key: 'strongSell', label: 'Strong Sell', color: '#ef4444' },
];
// Yahoo recommendationMean: 1 = Strong Buy … 5 = Strong Sell.
const recMeanLabel = (m) => {
  if (m == null) return { text: '—', color: GREY };
  if (m <= 1.5) return { text: 'STRONG BUY', color: '#15803d' };
  if (m <= 2.5) return { text: 'BUY', color: '#22c55e' };
  if (m <= 3.5) return { text: 'HOLD', color: '#eab308' };
  if (m <= 4.5) return { text: 'SELL', color: '#f97316' };
  return { text: 'STRONG SELL', color: '#ef4444' };
};
const periodLabel = (p) => ({ '0m': 'Now', '-1m': '1mo ago', '-2m': '2mo ago', '-3m': '3mo ago',
  '0q': 'This Qtr', '+1q': 'Next Qtr', '0y': 'This Year', '+1y': 'Next Year' }[p] || p);

// Horizontal low→high price-target bar with current-price and mean markers.
function TargetBar({ low, high, mean, current, money }) {
  const vals = [low, high, mean, current].filter(v => v != null);
  if (vals.length < 2) return null;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const pos = (v) => `${((v - lo) / span) * 100}%`;
  return (
    <div style={{ marginTop: '1.5rem' }}>
      <div style={{ position: 'relative', height: '8px', borderRadius: '4px', background: 'linear-gradient(90deg,#ef4444,#eab308,#22c55e)' }}>
        {low != null && high != null && (
          <div style={{ position: 'absolute', left: pos(low), right: `calc(100% - ${pos(high)})`, top: 0, bottom: 0, borderRadius: '4px', outline: '1px solid rgba(255,255,255,0.15)' }} />
        )}
        {current != null && (
          <div style={{ position: 'absolute', left: pos(current), top: '-7px', transform: 'translateX(-50%)' }}>
            <div style={{ width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '8px solid var(--text-primary)' }} />
          </div>
        )}
        {mean != null && (
          <div style={{ position: 'absolute', left: pos(mean), top: '-3px', width: '14px', height: '14px', borderRadius: '50%', background: '#fff', border: '3px solid var(--accent)', transform: 'translate(-50%,0)' }} />
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.7rem', fontSize: '0.78rem' }}>
        <div><div style={{ color: GREY, fontSize: '0.68rem' }}>LOW</div><strong style={{ color: RED }}>{money(low)}</strong></div>
        <div style={{ textAlign: 'center' }}><div style={{ color: 'var(--accent)', fontSize: '0.68rem' }}>● AVG TARGET</div><strong style={{ color: 'var(--accent)' }}>{money(mean)}</strong></div>
        <div style={{ textAlign: 'right' }}><div style={{ color: GREY, fontSize: '0.68rem' }}>HIGH</div><strong style={{ color: GREEN }}>{money(high)}</strong></div>
      </div>
      {current != null && (
        <div style={{ textAlign: 'center', marginTop: '0.6rem', fontSize: '0.78rem', color: GREY }}>
          ▼ Current <strong style={{ color: 'var(--text-primary)' }}>{money(current)}</strong>
        </div>
      )}
    </div>
  );
}

// Single 100%-width stacked bar of the five rating buckets, with count labels.
function RatingBar({ row }) {
  if (!row || !row.total) return null;
  return (
    <div>
      <div style={{ display: 'flex', height: '38px', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border)' }}>
        {REC_BUCKETS.map(b => {
          const n = row[b.key] || 0;
          if (!n) return null;
          const w = (n / row.total) * 100;
          return (
            <div key={b.key} title={`${b.label}: ${n}`} style={{ width: `${w}%`, background: b.color, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: '0.85rem' }}>
              {w > 7 ? n : ''}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
        {REC_BUCKETS.map(b => (
          <span key={b.key} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem', color: GREY }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: b.color }} />
            {b.label} <strong style={{ color: 'var(--text-primary)' }}>{row[b.key] || 0}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function AnalystsPanel({ fetchUrl, money, bigMoney, emptyNote }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let on = true; setLoading(true); setErr(null);
    fetch(fetchUrl).then(r => r.json())
      .then(j => { if (!on) return; if (j.error) setErr(j.error); else setD(j); })
      .catch(e => on && setErr(e.message)).finally(() => on && setLoading(false));
    return () => { on = false; };
  }, [fetchUrl]);

  if (loading) return <div className="loader" />;
  if (err) return <div className="glass-panel" style={{ padding: '1.5rem', color: RED }}>Failed to load analyst data: {err}</div>;
  if (!d) return null;

  const hasData = (d.analysts && d.analysts > 0) || (d.trend?.length > 0) || (d.ratings?.length > 0) || d.target?.mean != null;
  if (!hasData) return <div className="glass-panel" style={{ padding: '1.5rem', color: GREY }}>{emptyNote || 'No analyst coverage available for this stock.'}</div>;

  const rec = recMeanLabel(d.recommendationMean);
  const upside = d.target?.mean != null && d.currentPrice ? ((d.target.mean - d.currentPrice) / d.currentPrice) * 100 : null;
  const current = d.trend?.[0]; // '0m' — current period distribution
  const trendChart = [...(d.trend || [])].reverse().map(t => ({ ...t, name: periodLabel(t.period) }));

  return (
    <div style={{ display: 'grid', gap: '1.25rem' }}>
      {/* Consensus + price target */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.25rem' }}>
        <div className="glass-panel" style={{ padding: '1.25rem 1.5rem' }}>
          <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: GREY }}>Consensus Rating</div>
          <div style={{ fontSize: '1.9rem', fontWeight: 800, color: rec.color, margin: '0.35rem 0 0.1rem' }}>{rec.text}</div>
          <div style={{ fontSize: '0.8rem', color: GREY }}>
            {d.recommendationMean != null ? `Score ${d.recommendationMean.toFixed(2)} / 5` : ''}
            {d.analysts ? ` · ${d.analysts} analyst${d.analysts === 1 ? '' : 's'}` : ''}
          </div>
          {d.recommendationMean != null && (
            <div style={{ marginTop: '1rem' }}>
              <div style={{ position: 'relative', height: '8px', borderRadius: '4px', background: 'linear-gradient(90deg,#15803d,#22c55e,#eab308,#f97316,#ef4444)' }}>
                <div style={{ position: 'absolute', left: `${((d.recommendationMean - 1) / 4) * 100}%`, top: '-4px', transform: 'translateX(-50%)', width: '16px', height: '16px', borderRadius: '50%', background: '#fff', border: '3px solid #0f172a', boxShadow: '0 0 0 1px rgba(255,255,255,0.4)' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.45rem', fontSize: '0.66rem', color: GREY }}>
                <span>Strong Buy</span><span>Hold</span><span>Strong Sell</span>
              </div>
            </div>
          )}
        </div>

        <div className="glass-panel" style={{ padding: '1.25rem 1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: GREY }}>12-Month Price Target</div>
            {upside != null && (
              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: pctColor(upside) }}>{fmtPct(upside)} {upside >= 0 ? 'upside' : 'downside'}</div>
            )}
          </div>
          {d.target?.mean != null ? <TargetBar low={d.target.low} high={d.target.high} mean={d.target.mean} current={d.currentPrice} money={money} />
            : <div style={{ color: GREY, marginTop: '1rem', fontSize: '0.85rem' }}>No published price targets.</div>}
        </div>
      </div>

      {/* Current rating distribution */}
      {current && (
        <div className="glass-panel" style={{ padding: '1.25rem 1.5rem' }}>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.15rem' }}>Rating Distribution</div>
          <div style={{ fontSize: '0.72rem', color: GREY, marginBottom: '1rem' }}>How {current.total} covering analysts rate the stock today</div>
          <RatingBar row={current} />
        </div>
      )}

      {/* Recommendation trend over time */}
      {trendChart.length > 1 && (
        <div className="glass-panel" style={{ padding: '1.25rem 1.5rem' }}>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.15rem' }}>Rating Trend</div>
          <div style={{ fontSize: '0.72rem', color: GREY, marginBottom: '1rem' }}>How the analyst mix has shifted over recent months</div>
          <div style={{ height: '240px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trendChart} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="name" tick={{ fill: GREY, fontSize: 11 }} />
                <YAxis tick={{ fill: GREY, fontSize: 11 }} width={30} allowDecimals={false} />
                <Tooltip contentStyle={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '8px' }} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Legend />
                {REC_BUCKETS.map(b => (
                  <Bar key={b.key} dataKey={b.key} name={b.label} stackId="r" fill={b.color} isAnimationActive={false} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* EPS / revenue estimates */}
      {d.estimates?.length > 0 && (
        <div className="glass-panel" style={{ padding: '1.25rem 1.5rem' }}>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.15rem' }}>Earnings & Revenue Estimates</div>
          <div style={{ fontSize: '0.72rem', color: GREY, marginBottom: '1rem' }}>Consensus forecasts (low / avg / high)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '1rem' }}>
            {d.estimates.map(e => (
              <div key={e.period} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '0.85rem 1rem' }}>
                <div style={{ fontSize: '0.78rem', fontWeight: 700 }}>{periodLabel(e.period)}</div>
                {e.eps && (
                  <div style={{ marginTop: '0.6rem' }}>
                    <div style={{ fontSize: '0.66rem', color: GREY, textTransform: 'uppercase' }}>EPS</div>
                    <div style={{ fontSize: '1.15rem', fontWeight: 700 }}>{money(e.eps.avg)}</div>
                    <div style={{ fontSize: '0.7rem', color: GREY }}>{money(e.eps.low)} – {money(e.eps.high)}{e.eps.analysts ? ` · ${e.eps.analysts} est` : ''}</div>
                    {e.eps.growth != null && <div style={{ fontSize: '0.72rem', fontWeight: 600, color: pctColor(e.eps.growth) }}>{fmtPct(e.eps.growth)} YoY</div>}
                  </div>
                )}
                {e.revenue && e.revenue.avg != null && (
                  <div style={{ marginTop: '0.6rem' }}>
                    <div style={{ fontSize: '0.66rem', color: GREY, textTransform: 'uppercase' }}>Revenue</div>
                    <div style={{ fontSize: '0.95rem', fontWeight: 700 }}>{bigMoney(e.revenue.avg)}</div>
                    {e.revenue.growth != null && <div style={{ fontSize: '0.72rem', fontWeight: 600, color: pctColor(e.revenue.growth) }}>{fmtPct(e.revenue.growth)} YoY</div>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent rating changes */}
      {d.ratings?.length > 0 && (
        <div className="glass-panel" style={{ padding: '1.25rem 1.5rem' }}>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '1rem' }}>Recent Rating Changes</div>
          <div style={{ display: 'grid', gap: '0.1rem' }}>
            {d.ratings.map((r, i) => {
              const act = (r.action || '').toLowerCase();
              const mark = act === 'up' ? { t: '▲', c: GREEN } : act === 'down' ? { t: '▼', c: RED } : act === 'init' ? { t: '●', c: 'var(--accent)' } : { t: '–', c: GREY };
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0', borderBottom: '1px solid var(--border)', fontSize: '0.84rem' }}>
                  <span style={{ color: mark.c, width: '14px', fontWeight: 700 }}>{mark.t}</span>
                  <span style={{ color: GREY, width: '88px', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fmtDate(r.date)}</span>
                  <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.firm}</span>
                  <span style={{ color: GREY }}>{r.fromGrade && r.fromGrade !== r.toGrade ? `${r.fromGrade} → ` : ''}<strong style={{ color: 'var(--text-primary)' }}>{r.toGrade}</strong></span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p style={{ fontSize: '0.7rem', color: GREY, fontStyle: 'italic' }}>
        Analyst data via Yahoo Finance{d.cached ? ' · cached' : ''}. Estimates are consensus and not investment advice.
      </p>
    </div>
  );
}
