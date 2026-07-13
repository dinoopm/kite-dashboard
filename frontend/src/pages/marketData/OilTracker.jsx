import { useState, useEffect, useCallback } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts'

// Crude oil tracker: WTI (CL=F) + Brent (BZ=F) spot cards from /api/oil plus
// a combined daily-close chart from /api/oil/history (Yahoo, 10-min delayed
// NYMEX). Spread/INR are deliberate non-goals
// (see docs/superpowers/specs/2026-07-12-oil-tracker-design.md).
const GREY = 'var(--text-secondary)'
const REFRESH_MS = 60000
const TIMEFRAMES = ['1D', '1W', '1M', '6M', '1Y']
const BRENT_COLOR = '#fbbf24'

const fmt = (v, digits = 2) => (v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }))

// Horizontal range bar: low ── ● ── high, marker at `value`.
function RangeBar({ low, high, value, lowLabel, highLabel }) {
  if (low == null || high == null || value == null || high <= low) return null
  const pct = Math.max(0, Math.min(100, ((value - low) / (high - low)) * 100))
  return (
    <div style={{ marginTop: '0.35rem' }}>
      <div style={{ position: 'relative', height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.08)' }}>
        <div style={{ position: 'absolute', left: `calc(${pct}% - 4px)`, top: '-2px', width: '10px', height: '10px', borderRadius: '50%', background: 'var(--accent)' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem', color: GREY, marginTop: '0.2rem' }}>
        <span>{lowLabel}</span><span>{highLabel}</span>
      </div>
    </div>
  )
}

function GradeCard({ g }) {
  if (!g) return null
  const up = (g.change ?? 0) >= 0
  return (
    <div className="glass-panel" style={{ padding: '1.25rem 1.5rem', flex: '1 1 320px', minWidth: '300px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '1.05rem' }}>{g.name}</h3>
        <span style={{ fontSize: '0.68rem', fontWeight: 700, color: GREY, border: '1px solid var(--border)', borderRadius: '4px', padding: '0.08rem 0.35rem' }}>{g.symbol ?? '—'}</span>
        {g.marketState && <span style={{ fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: g.marketState === 'REGULAR' ? '#34d399' : GREY }}>{g.marketState}</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.7rem', margin: '0.6rem 0 0.2rem' }}>
        <span style={{ fontSize: '2rem', fontWeight: 800 }}>${fmt(g.price)}</span>
        {g.change != null && (
          <span className={up ? 'positive' : 'negative'} style={{ fontWeight: 700 }}>
            {up ? '+' : ''}{fmt(g.change)} ({up ? '+' : ''}{fmt(g.changePct)}%)
          </span>
        )}
      </div>
      <div style={{ fontSize: '0.78rem', color: GREY }}>Prev close ${fmt(g.prevClose)}</div>
      <div style={{ marginTop: '0.9rem' }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: GREY }}>Day range</div>
        <RangeBar low={g.dayLow} high={g.dayHigh} value={g.price} lowLabel={`$${fmt(g.dayLow)}`} highLabel={`$${fmt(g.dayHigh)}`} />
      </div>
      <div style={{ marginTop: '0.8rem' }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: GREY }}>52-week range</div>
        <RangeBar low={g.week52Low} high={g.week52High} value={g.price} lowLabel={`$${fmt(g.week52Low)}`} highLabel={`$${fmt(g.week52High)}`} />
      </div>
    </div>
  )
}

// Combined WTI + Brent daily-close chart with timeframe toggle.
function OilChart() {
  const [tf, setTf] = useState('1M')
  const [hist, setHist] = useState(null)   // { tf, points } for the active tf
  const [histError, setHistError] = useState(null)

  useEffect(() => {
    let on = true
    setHist(null); setHistError(null)
    fetch(`/api/oil/history?tf=${tf}`)
      .then(r => r.json().then(j => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!on) return
        if (!ok) throw new Error(j.error || 'history unavailable')
        setHist(j)
      })
      .catch(e => { if (on) setHistError(e.message) })
    return () => { on = false }
  }, [tf])

  // Change over the visible window: first → last non-null close per grade.
  const periodChange = (key) => {
    const pts = hist?.points || []
    const first = pts.find(p => p[key] != null)?.[key]
    const last = [...pts].reverse().find(p => p[key] != null)?.[key]
    if (first == null || last == null || first === 0) return null
    return { abs: last - first, pct: ((last - first) / first) * 100 }
  }
  const changeChip = (label, color, c) => c && (
    <span style={{ fontSize: '0.78rem', fontWeight: 700 }}>
      <span style={{ color }}>{label}</span>{' '}
      <span className={c.abs >= 0 ? 'positive' : 'negative'}>
        {c.abs >= 0 ? '+' : ''}{fmt(c.abs)} ({c.abs >= 0 ? '+' : ''}{fmt(c.pct)}%)
      </span>
    </span>
  )

  return (
    <div className="glass-panel" style={{ padding: '1.1rem 1.25rem', marginTop: '1.25rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.6rem', marginBottom: '0.6rem' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.9rem', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: '1.02rem' }}>Price history <span style={{ fontSize: '0.72rem', color: GREY, fontWeight: 500 }}>{hist?.intraday ? 'intraday' : 'daily'} closes, $/bbl</span></h3>
          {hist && changeChip('WTI', 'var(--accent)', periodChange('wti'))}
          {hist && changeChip('Brent', BRENT_COLOR, periodChange('brent'))}
        </div>
        <div style={{ display: 'flex', gap: '0.35rem' }}>
          {TIMEFRAMES.map(t => (
            <button key={t} onClick={() => setTf(t)} style={{
              padding: '0.25rem 0.7rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 700,
              border: `1px solid ${tf === t ? 'var(--accent)' : 'var(--border)'}`,
              background: tf === t ? 'rgba(56,189,248,0.12)' : 'transparent',
              color: tf === t ? 'var(--accent)' : GREY,
            }}>{t}</button>
          ))}
        </div>
      </div>
      {histError ? (
        <p style={{ margin: 0, color: GREY, fontSize: '0.85rem' }}>Chart unavailable: {histError}</p>
      ) : !hist ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}><div className="loader" /></div>
      ) : (
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={hist.points} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} tickLine={false} axisLine={false}
              minTickGap={40} tickFormatter={d => {
                // Daily points are 'YYYY-MM-DD'; intraday points are full ISO timestamps.
                if (hist.intraday) {
                  const t = new Date(d)
                  return tf === '1D'
                    ? t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                    : t.toLocaleDateString('en-US', { weekday: 'short', hour: 'numeric' })
                }
                return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
              }} />
            <YAxis domain={['auto', 'auto']} tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} tickLine={false} axisLine={false} width={48}
              tickFormatter={v => `$${v}`} />
            <Tooltip
              contentStyle={{ background: '#1e293b', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '0.8rem' }}
              labelStyle={{ color: 'var(--text-secondary)' }}
              labelFormatter={d => (hist.intraday
                ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                : d)}
              formatter={(v, name) => [`$${fmt(v)}`, name === 'wti' ? 'WTI' : 'Brent']} />
            <Legend formatter={name => (name === 'wti' ? 'WTI (CL=F)' : 'Brent (BZ=F)')} wrapperStyle={{ fontSize: '0.78rem' }} />
            <Line type="monotone" dataKey="wti" stroke="var(--accent)" strokeWidth={2} dot={false} connectNulls />
            <Line type="monotone" dataKey="brent" stroke={BRENT_COLOR} strokeWidth={2} dot={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

export default function OilTracker() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/oil')
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setData(j); setError(null)
    } catch (e) { setError(e.message) }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  if (error && !data) return (
    <div className="dashboard-layout">
      <div className="glass-panel" style={{ padding: '1.5rem' }}>
        <p className="negative" style={{ margin: 0 }}>Oil prices unavailable: {error}</p>
        <button onClick={load} style={{ marginTop: '1rem', padding: '0.5rem 1rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Retry</button>
      </div>
    </div>
  )
  if (!data) return <div className="loader" />

  const asOf = data.wti?.quoteTime ? new Date(data.wti.quoteTime).toLocaleTimeString() : null
  return (
    <div className="dashboard-layout">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.25rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>Crude Oil</h1>
          <p style={{ margin: '0.3rem 0 0', color: GREY, fontSize: '0.85rem' }}>
            WTI &amp; Brent spot · Yahoo Finance · {data.wti?.delayMin ?? 10}-min delayed
            {asOf && <> · as of {asOf}</>}
            {data.stale && <span style={{ color: '#fbbf24' }}> · stale data</span>}
            {error && <span style={{ color: '#fbbf24' }}> · refresh failed — showing last data</span>}
          </p>
        </div>
        <button onClick={load} title="Refresh prices"
          style={{ padding: '0.4rem 0.9rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 700, border: '1px solid rgba(56,189,248,0.25)', background: 'rgba(56,189,248,0.08)', color: 'var(--accent)' }}>
          ↻ Refresh
        </button>
      </div>
      <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap' }}>
        <GradeCard g={data.wti} />
        <GradeCard g={data.brent} />
      </div>
      <OilChart />
    </div>
  )
}
