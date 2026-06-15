import { useState, useEffect, useCallback } from 'react'
import { fetchWithAbort } from '../../hooks/useFetchWithAbort'

const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`)

// Saved runs for one surface (kind='single' filtered by symbol, or kind='basket').
// Row click loads the stored result back into the parent via onLoad(run).
export default function PastRunsList({ kind, symbol, onLoad, refreshKey }) {
  const [runs, setRuns] = useState(null)
  const [error, setError] = useState(null)
  const [loadingId, setLoadingId] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    ;(async () => {
      try {
        const qs = new URLSearchParams({ kind })
        if (symbol) qs.set('symbol', symbol)
        const res = await fetchWithAbort(`/api/backtest/runs?${qs}`, { signal: controller.signal })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
        setRuns(data.runs || [])
        setError(null)
      } catch (e) {
        if (e.name === 'AbortError') return
        setError(e.message)
      }
    })()
    return () => controller.abort()
  }, [kind, symbol, refreshKey])

  const loadRun = useCallback(async (id) => {
    setLoadingId(id)
    try {
      const res = await fetchWithAbort(`/api/backtest/runs/${id}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
      onLoad(data.run)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoadingId(null)
    }
  }, [onLoad])

  const deleteRun = useCallback(async (id) => {
    if (!window.confirm('Delete this saved run?')) return
    try {
      const res = await fetchWithAbort(`/api/backtest/runs/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`Delete failed (${res.status})`)
      setRuns(rs => (rs || []).filter(r => r.id !== id))
    } catch (e) {
      setError(e.message)
    }
  }, [])

  if (error) return <p className="negative" style={{ fontSize: '0.85rem' }}>{error}</p>
  if (!runs) return <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Loading saved runs…</p>
  if (runs.length === 0) return <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>No saved runs yet — run a backtest and hit Save.</p>

  const td = { fontSize: '0.82rem', padding: '0.55rem 0.9rem', whiteSpace: 'nowrap' }
  return (
    <div className="glass-panel" style={{ padding: '0.5rem 1rem 1rem', overflowX: 'auto' }}>
      <table>
        <thead>
          <tr>
            <th style={{ fontSize: '0.75rem' }}>Saved</th>
            <th style={{ fontSize: '0.75rem' }}>Label</th>
            <th style={{ fontSize: '0.75rem', textAlign: 'right' }}>Return</th>
            <th style={{ fontSize: '0.75rem', textAlign: 'right' }}>Win rate</th>
            <th style={{ fontSize: '0.75rem', textAlign: 'right' }}>Max DD</th>
            <th style={{ fontSize: '0.75rem', textAlign: 'right' }}>Trades</th>
            <th style={{ fontSize: '0.75rem' }}></th>
          </tr>
        </thead>
        <tbody>
          {runs.map(r => (
            <tr key={r.id}>
              <td style={td}>{new Date(r.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
              <td style={td}>{r.label}</td>
              <td style={{ ...td, textAlign: 'right' }} className={r.metrics?.totalReturnPct > 0 ? 'positive' : r.metrics?.totalReturnPct < 0 ? 'negative' : ''}>
                {fmtPct(r.metrics?.totalReturnPct)}
              </td>
              <td style={{ ...td, textAlign: 'right' }}>{r.metrics?.winRate != null ? `${r.metrics.winRate}%` : '—'}</td>
              <td style={{ ...td, textAlign: 'right' }} className="negative">{fmtPct(r.metrics?.maxDrawdownPct)}</td>
              <td style={{ ...td, textAlign: 'right' }}>{r.metrics?.totalTrades ?? '—'}</td>
              <td style={{ ...td, textAlign: 'right' }}>
                <button
                  onClick={() => loadRun(r.id)}
                  disabled={loadingId === r.id}
                  style={{ background: 'transparent', border: '1px solid var(--accent)', color: 'var(--accent)', borderRadius: '6px', padding: '0.2rem 0.7rem', cursor: 'pointer', fontSize: '0.75rem', marginRight: '0.5rem' }}
                >
                  {loadingId === r.id ? 'Loading…' : 'Load'}
                </button>
                <button
                  onClick={() => deleteRun(r.id)}
                  style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', padding: '0.2rem 0.7rem', cursor: 'pointer', fontSize: '0.75rem' }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
