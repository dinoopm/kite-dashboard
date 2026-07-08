import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell, ReferenceLine } from 'recharts'

// Trade journal: round trips and performance stats reconstructed (FIFO) from
// trade_log — see backend/journal/engine.js. Kite only exposes today's fills,
// so the backend accumulates them daily; history comes from a Zerodha Console
// tradebook CSV imported here.
const GREEN = '#34d399', RED = '#f87171', GREY = 'var(--text-secondary)'

function StatCard({ label, value, sub, color }) {
  return (
    <div className="glass-panel" style={{ padding: '1.1rem 1.3rem', flex: '1', minWidth: '160px' }}>
      <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: GREY }}>{label}</div>
      <div style={{ fontSize: '1.4rem', fontWeight: 700, color: color || 'var(--text-primary)', marginTop: '0.2rem' }}>{value}</div>
      {sub && <div style={{ fontSize: '0.72rem', color: GREY, marginTop: '0.15rem' }}>{sub}</div>}
    </div>
  )
}

const inr = (v) => (v == null ? '—' : `${v < 0 ? '−' : ''}₹${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`)

// Quick ranges: label → days back from today (null = all history, 'ytd' = Jan 1).
const PRESETS = [['1M', 30], ['3M', 91], ['6M', 182], ['YTD', 'ytd'], ['1Y', 365], ['All', null]]
const isoDaysAgo = (d) => { const x = new Date(); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10) }

export default function Journal() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [importMsg, setImportMsg] = useState(null)
  const [range, setRange] = useState({ from: '', to: '' }) // closed trades filtered by EXIT date
  const [preset, setPreset] = useState('All')
  const fileRef = useRef(null)

  const load = (r = range) => {
    setLoading(true); setError(null)
    const qs = new URLSearchParams()
    if (r.from) qs.set('from', r.from)
    if (r.to) qs.set('to', r.to)
    fetch(`/api/journal/stats${qs.toString() ? '?' + qs : ''}`)
      .then(res => res.json())
      .then(j => { if (j.error) setError(j.error); else setData(j) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load({ from: '', to: '' }) }, [])

  const applyPreset = (label, days) => {
    setPreset(label)
    const r = days == null ? { from: '', to: '' }
      : days === 'ytd' ? { from: `${new Date().getFullYear()}-01-01`, to: '' }
      : { from: isoDaysAgo(days), to: '' }
    setRange(r)
    load(r)
  }
  const applyCustom = (r) => { setRange(r); setPreset(null); load(r) }

  const importCsv = async (file) => {
    if (!file) return
    setImportMsg('Importing…')
    try {
      const text = await file.text()
      const r = await fetch('/api/journal/import', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setImportMsg(`Imported ${j.imported} fills — recomputing…`)
      load()
    } catch (e) {
      setImportMsg(`Import failed: ${e.message}`)
    }
  }

  if (loading) return <div className="loader" />
  if (error) return <div className="glass-panel" style={{ padding: '1.5rem', color: RED }}>Journal unavailable: {error}<div style={{ color: GREY, fontSize: '0.8rem', marginTop: '0.5rem' }}>If the trade_log table doesn't exist yet, run backend/migrate_trade_log.js and paste the SQL into Supabase.</div></div>

  const s = data?.stats
  const empty = data?.empty || !s

  return (
    <div className="dashboard-layout">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>Trade Journal</h1>
          <p style={{ margin: '0.3rem 0 0', color: GREY, fontSize: '0.85rem' }}>
            {data?.fills || 0} fills · {data?.trades || 0}{data?.range && data?.allTrades !== data?.trades ? ` of ${data.allTrades}` : ''} closed round trips (FIFO, flat-to-flat{data?.range ? `, exited ${data.range.from || 'start'} → ${data.range.to || 'today'}` : ''})
            {data?.unmatchedSellQty > 0 && ` · ${data.unmatchedSellQty} sold shares had no recorded entry (pre-history) — excluded`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
          <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={e => importCsv(e.target.files?.[0])} />
          <button onClick={() => fileRef.current?.click()} style={{
            padding: '0.55rem 1rem', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '0.85rem',
            border: '1px solid rgba(56,189,248,0.25)', background: 'rgba(56,189,248,0.08)', color: 'var(--accent)',
          }}>⤒ Import Console tradebook CSV</button>
          {importMsg && <span style={{ fontSize: '0.78rem', color: GREY }}>{importMsg}</span>}
        </div>
      </div>

      {/* Date-range filter — applies to closed trades by exit date */}
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
        {PRESETS.map(([label, days]) => (
          <button key={label} onClick={() => applyPreset(label, days)} style={{
            padding: '0.35rem 0.75rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 700,
            border: `1px solid ${preset === label ? 'var(--accent)' : 'var(--border)'}`,
            background: preset === label ? 'rgba(56,189,248,0.12)' : 'transparent',
            color: preset === label ? 'var(--accent)' : GREY,
          }}>{label}</button>
        ))}
        <span style={{ color: GREY, fontSize: '0.78rem', marginLeft: '0.5rem' }}>or</span>
        <input type="date" value={range.from} onChange={e => applyCustom({ ...range, from: e.target.value })}
          style={{ padding: '0.3rem 0.5rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-dark)', color: 'var(--text-primary)', fontSize: '0.78rem', colorScheme: 'dark' }} />
        <span style={{ color: GREY, fontSize: '0.78rem' }}>→</span>
        <input type="date" value={range.to} onChange={e => applyCustom({ ...range, to: e.target.value })}
          style={{ padding: '0.3rem 0.5rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-dark)', color: 'var(--text-primary)', fontSize: '0.78rem', colorScheme: 'dark' }} />
      </div>

      {empty ? (
        <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center', color: GREY }}>
          {data?.fills > 0 ? (
            <p style={{ margin: 0 }}>No closed trades in this date range — widen it or pick All.</p>
          ) : (
            <>
              <p style={{ margin: 0 }}>No trades recorded yet.</p>
              <p style={{ margin: '0.6rem 0 0', fontSize: '0.85rem' }}>
                Today's fills sync automatically when you open this page on a trading day. For history, export your
                tradebook from Zerodha Console (Reports → Tradebook → CSV) and import it above.
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
            <StatCard label="Win rate" value={`${s.winRate}%`} sub={`${data.trades} closed trades`} color={s.winRate >= 50 ? GREEN : RED} />
            <StatCard label="Total P&L" value={inr(s.totalPnl)} color={s.totalPnl >= 0 ? GREEN : RED} />
            <StatCard label="Avg win / loss" value={`+${s.avgWinPct ?? '—'}% / ${s.avgLossPct ?? '—'}%`}
              sub={s.avgWinPct != null && s.avgLossPct != null ? `ratio ${Math.abs(s.avgWinPct / s.avgLossPct).toFixed(2)}` : null} />
            <StatCard label="Expectancy" value={`${s.expectancyPct >= 0 ? '+' : ''}${s.expectancyPct}%`} sub="mean return per trade" color={s.expectancyPct >= 0 ? GREEN : RED} />
            <StatCard label="Profit factor" value={s.profitFactor ?? '—'} sub="gross wins ÷ gross losses" color={s.profitFactor >= 1 ? GREEN : RED} />
            <StatCard label="Median hold" value={`${s.medianHoldingDays}d`} />
            {s.pickTrades > 0 && (
              <StatCard label="Quant-pick entries" value={`${s.pickWinRate}%`} sub={`win rate over ${s.pickTrades} pick trades`}
                color={s.pickWinRate >= (s.winRate || 0) ? GREEN : RED} />
            )}
          </div>

          {data.monthly.length > 1 && (
            <div className="glass-panel" style={{ padding: '1.1rem 1.3rem', marginBottom: '1.25rem' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--accent)', marginBottom: '0.6rem' }}>Monthly P&L</div>
              <div style={{ height: 180 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.monthly} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} tickFormatter={v => inr(v)} width={78} />
                    <Tooltip contentStyle={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '0.78rem' }} formatter={v => [inr(v), 'P&L']} />
                    <ReferenceLine y={0} stroke="var(--border)" />
                    <Bar dataKey="pnl" isAnimationActive={false}>
                      {data.monthly.map(m => <Cell key={m.month} fill={m.pnl >= 0 ? GREEN : RED} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {data.openPositions.length > 0 && (
            <div className="glass-panel" style={{ padding: '1.1rem 1.3rem', marginBottom: '1.25rem' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--accent)', marginBottom: '0.4rem' }}>Open positions (from journal)</div>
              <div style={{ display: 'flex', gap: '1.2rem', flexWrap: 'wrap', fontSize: '0.85rem' }}>
                {data.openPositions.map(p => (
                  <span key={p.symbol}><b>{p.symbol}</b> {p.qty} @ ₹{p.avgPrice} <span style={{ color: GREY }}>since {p.since}</span></span>
                ))}
              </div>
            </div>
          )}

          <div className="glass-panel" style={{ padding: '0 0 0.25rem' }}>
            <div style={{ padding: '0.7rem 1rem', fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--accent)', borderBottom: '1px solid var(--border)' }}>
              Closed trades (latest {data.trips.length})
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="interactive-table" style={{ width: '100%' }}>
                <thead>
                  <tr style={{ fontSize: '0.72rem' }}>
                    <th>Symbol</th><th>Entry</th><th>Exit</th><th>Days</th><th>Qty</th><th>Avg in → out</th><th>P&L</th><th>Return</th><th>Tags</th>
                  </tr>
                </thead>
                <tbody>
                  {data.trips.map((t, i) => (
                    <tr key={i} style={{ fontSize: '0.83rem' }}>
                      <td><Link to={`/instrument/0?symbol=${encodeURIComponent(t.symbol)}`} style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{t.symbol}</Link></td>
                      <td>{t.entryDate}</td>
                      <td>{t.exitDate}</td>
                      <td>{t.holdingDays}</td>
                      <td>{t.qty}</td>
                      <td>₹{t.entryAvg} → ₹{t.exitAvg}</td>
                      <td className={t.pnl >= 0 ? 'positive' : 'negative'}>{inr(t.pnl)}</td>
                      <td className={t.pnl >= 0 ? 'positive' : 'negative'}>{t.pnlPct >= 0 ? '+' : ''}{t.pnlPct}%</td>
                      <td>{t.wasPick && <span style={{ fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--accent)', border: '1px solid rgba(56,189,248,0.35)', borderRadius: '4px', padding: '0.05rem 0.3rem' }}>quant pick</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
