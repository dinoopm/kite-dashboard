import { useMemo, useState } from 'react'
import { ResponsiveContainer, AreaChart, Area, YAxis, XAxis, Tooltip, ReferenceLine } from 'recharts'
import { computeVolStats, volRegime } from '../lib/volatility'

// Badge palette matches RedFlagsPanel's severity colors.
const TONES = {
  good: { color: '#34d399', border: 'rgba(52,211,153,0.45)' },
  neutral: { color: 'var(--text-secondary)', border: 'var(--border)' },
  warn: { color: '#fbbf24', border: 'rgba(251,191,36,0.45)' },
  alert: { color: '#f87171', border: 'rgba(239,68,68,0.5)' },
}

// Historical-volatility card shared by the India and US instrument pages.
// Purely presentational: takes ascending daily bars ({ date, close }) that the
// page has already fetched (India: 5Y signalBars, US: 2Y dailyBars) and shows
// annualized close-to-close HV over 20/60/252 days, the equivalent typical
// daily move, and a 1-year sparkline of rolling 20D vol so the headline number
// has "is this normal for this stock?" context.
export default function VolatilityPanel({ bars, currency = '' }) {
  const stats = useMemo(() => computeVolStats(bars), [bars])
  // "How much am I OK losing on one rough day" — drives the position-size
  // suggestion. Persisted per currency so it survives navigation.
  const budgetKey = `volRiskBudget:${currency || 'x'}`
  const [budget, setBudget] = useState(() => {
    const saved = Number(localStorage.getItem(budgetKey))
    return saved > 0 ? saved : (currency === '$' ? 100 : 2000)
  })
  if (!stats) return null

  const { hv20, hv60, hv252, dailySigma, series, pctile, median } = stats
  const fmt = (v) => (v != null ? `${v.toFixed(1)}%` : '—')
  const regime = volRegime(pctile, hv20)
  const tone = regime ? TONES[regime.tone] : null

  // Translate the daily σ into money on the last close so "±2.4%" reads as
  // "about ₹58 on a ₹2,400 share".
  const lastClose = bars[bars.length - 1]?.close
  const moveAbs = dailySigma != null && lastClose ? (dailySigma / 100) * lastClose : null
  const fmtMoney = (v) => `${currency}${v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2)}`

  return (
    <section className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1.25rem' }}>
      <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'stretch', flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 auto', minWidth: '230px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
            <span style={{ fontSize: '0.85rem', fontWeight: 700 }}>
              Volatility <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>(annualized HV)</span>
            </span>
            {regime && (
              <span style={{
                fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px',
                color: tone.color, border: `1px solid ${tone.border}`, borderRadius: '4px', padding: '0.05rem 0.35rem',
              }}>{regime.label}</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '1.4rem' }}>
            {[['20D', hv20], ['60D', hv60], ['1Y', hv252]].map(([label, v]) => (
              <div key={label}>
                <div style={{ fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-secondary)' }}>{label}</div>
                <div style={{ fontSize: '1.05rem', fontWeight: 600 }}>{fmt(v)}</div>
              </div>
            ))}
          </div>
          {dailySigma != null && (
            <div style={{ fontSize: '0.78rem', marginTop: '0.55rem' }}>
              Typically moves <b>±{dailySigma.toFixed(1)}%</b> a day
              {moveAbs != null ? <span style={{ color: 'var(--text-secondary)' }}> — about {fmtMoney(moveAbs)} on a {fmtMoney(lastClose)} share</span> : null}
            </div>
          )}
          {regime && (
            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
              Right now it's {regime.blurb}.
            </div>
          )}
          <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', fontStyle: 'italic', marginTop: '0.45rem', maxWidth: '320px', lineHeight: 1.45 }}>
            Volatility isn't good or bad — it's how bumpy the ride is. Higher = bigger possible gains <i>and</i> losses, so size positions smaller and give stops more room.
          </div>
        </div>
        {series.length >= 30 && (
          <div style={{ flex: '1 1 260px', minWidth: '220px', height: 90, alignSelf: 'center' }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                <defs>
                  <linearGradient id="hvFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" hide />
                <YAxis domain={['auto', 'auto']} hide />
                {median != null && (
                  <ReferenceLine y={median} stroke="var(--text-secondary)" strokeDasharray="4 4" strokeOpacity={0.5} />
                )}
                <Tooltip
                  contentStyle={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '0.72rem' }}
                  labelStyle={{ color: 'var(--text-secondary)' }}
                  labelFormatter={(d) => (typeof d === 'string' && d.includes('T') ? d.slice(0, 10) : d)}
                  formatter={(v) => [`${v}%`, '20D HV']}
                />
                <Area type="monotone" dataKey="vol" stroke="var(--accent)" strokeWidth={1.5} fill="url(#hvFill)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
            <div style={{ fontSize: '0.62rem', color: 'var(--text-secondary)', textAlign: 'right', marginTop: '-2px' }}>
              rolling 20D volatility · 1Y {median != null ? `· median ${median.toFixed(0)}%` : ''}
            </div>
          </div>
        )}
      </div>

      {/* Decision guide — deterministic translations of the σ into the two
          calls a holder actually makes: where the stop can live, and how big
          the position can be for a chosen worst-rough-day loss. */}
      {dailySigma != null && lastClose != null && (() => {
        const roughDayPct = 2 * dailySigma // a bad-but-ordinary day ≈ 2σ
        const stopPrice = lastClose * (1 - roughDayPct / 100)
        const maxPosition = budget > 0 ? budget / (roughDayPct / 100) : null
        const onBudget = (e) => {
          const v = Number(e.target.value)
          setBudget(v)
          if (v > 0) localStorage.setItem(budgetKey, String(v))
        }
        return (
          <div style={{ borderTop: '1px solid var(--border)', marginTop: '0.9rem', paddingTop: '0.75rem', display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 240px' }}>
              <div style={{ fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-secondary)', marginBottom: '0.3rem' }}>Stop-loss room</div>
              <div style={{ fontSize: '0.78rem', lineHeight: 1.5 }}>
                Give stops at least <b>{roughDayPct.toFixed(1)}%</b> of room — below <b>{fmtMoney(stopPrice)}</b> from here.
                <span style={{ color: 'var(--text-secondary)' }}> Anything tighter sits inside 2 typical daily moves and gets hit by noise, not by being wrong.</span>
              </div>
            </div>
            <div style={{ flex: '1 1 240px' }}>
              <div style={{ fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-secondary)', marginBottom: '0.3rem' }}>Position size</div>
              <div style={{ fontSize: '0.78rem', lineHeight: 1.6 }}>
                If a rough day should cost you at most {currency}
                <input
                  type="number" min="0" value={budget} onChange={onBudget}
                  style={{
                    width: '5.5em', margin: '0 0.15rem', padding: '0.05rem 0.3rem', fontSize: '0.78rem',
                    background: 'var(--bg-panel)', color: 'var(--text-primary)',
                    border: '1px solid var(--border)', borderRadius: '4px',
                  }}
                />, keep this position under{' '}
                <b>{maxPosition != null && isFinite(maxPosition) ? fmtMoney(maxPosition) : '—'}</b>.
                <span style={{ color: 'var(--text-secondary)' }}> (= budget ÷ {roughDayPct.toFixed(1)}% rough-day move)</span>
              </div>
            </div>
          </div>
        )
      })()}
    </section>
  )
}
