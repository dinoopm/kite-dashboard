import { useState, useEffect } from 'react'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'

// US 10-Year Treasury yield (^TNX) chart — the risk-free rate that drives
// equity valuations and FII flows into/out of India. Range-selectable; feeds
// from /api/us/treasury-10y (Yahoo). Pairs with the RiskRegimePanel, which
// reads the same yield as one of its gauges.
const RANGES = ['1M', '3M', '6M', '1Y', '5Y']
const GREY = 'var(--text-secondary)'

const fmtTick = (t, range) => {
  const d = new Date(t)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: range === '5Y' ? '2-digit' : undefined })
}
const asOfClock = (iso) => { try { return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET' } catch { return null } }

export default function TreasuryChart() {
  const [range, setRange] = useState('6M')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let on = true
    setData(null); setError(null)
    fetch(`/api/us/treasury-10y?range=${range}`)
      .then(r => r.json())
      .then(j => { if (!on) return; j.error ? setError(j.error) : setData(j) })
      .catch(e => on && setError(e.message))
    return () => { on = false }
  }, [range])

  const up = data?.changeBps != null && data.changeBps >= 0
  const stroke = up ? '#f87171' : '#34d399' // rising yields = risk-off tint (red)

  const pill = (active) => ({
    padding: '0.25rem 0.6rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 700,
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    background: active ? 'rgba(56,189,248,0.12)' : 'transparent',
    color: active ? 'var(--accent)' : GREY,
  })

  return (
    <div className="glass-panel" style={{ padding: '1.1rem 1.3rem', marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.7rem', flexWrap: 'wrap', marginBottom: '0.8rem' }}>
        <span style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--accent)' }}>US 10Y Treasury yield</span>
        {data?.current != null && (
          <>
            <span style={{ fontSize: '1.5rem', fontWeight: 800 }}>{data.current.toFixed(2)}%</span>
            {data.todayBps != null && (
              <span style={{ fontSize: '0.82rem', fontWeight: 700, color: data.todayBps >= 0 ? '#f87171' : '#34d399' }}>
                {data.todayBps >= 0 ? '+' : ''}{data.todayBps} bps <span style={{ color: GREY, fontWeight: 500 }}>today</span>
              </span>
            )}
            {data.changeBps != null && (
              <span style={{ fontSize: '0.78rem', fontWeight: 600, color: GREY }}>
                {up ? '+' : ''}{data.changeBps} bps over {range}
              </span>
            )}
            {data.asOf && <span style={{ fontSize: '0.68rem', color: GREY, marginLeft: '0.2rem' }}>as of {asOfClock(data.asOf)}</span>}
          </>
        )}
        <div style={{ display: 'flex', gap: '0.3rem', marginLeft: 'auto', flexWrap: 'wrap' }}>
          {RANGES.map(r => <button key={r} onClick={() => setRange(r)} style={pill(range === r)}>{r}</button>)}
        </div>
      </div>

      <div style={{ height: 200 }}>
        {error ? (
          <div style={{ color: 'var(--danger)', fontSize: '0.85rem', padding: '2rem 0', textAlign: 'center' }}>Couldn't load yield data: {error}</div>
        ) : !data ? (
          <div className="loader" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.series} margin={{ top: 6, right: 8, bottom: 0, left: -8 }}>
              <defs>
                <linearGradient id="tnxFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" strokeOpacity={0.4} vertical={false} />
              <XAxis dataKey="t" tickFormatter={t => fmtTick(t, range)} tick={{ fontSize: 10, fill: GREY }} minTickGap={40} />
              <YAxis domain={['auto', 'auto']} tickFormatter={v => `${v.toFixed(1)}%`} tick={{ fontSize: 10, fill: GREY }} width={44} />
              <Tooltip
                contentStyle={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '0.78rem' }}
                labelFormatter={t => fmtTick(t, range)}
                formatter={v => [`${v.toFixed(2)}%`, '10Y yield']}
              />
              <Area type="monotone" dataKey="y" stroke={stroke} strokeWidth={1.6} fill="url(#tnxFill)" isAnimationActive={false} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
      <div style={{ fontSize: '0.66rem', color: GREY, fontStyle: 'italic', marginTop: '0.4rem' }}>
        Rising yields pull money toward bonds and out of emerging-market equities like India · {data?.source || 'Yahoo Finance'}
      </div>
    </div>
  )
}
