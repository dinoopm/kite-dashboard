import { useState, useEffect } from 'react'
import { fetchWithAbort } from '../../hooks/useFetchWithAbort'

// Fetches the strategy registry once. Shared by the Instrument tab and the
// basket page so both render the same schema-driven controls.
export function useStrategies() {
  const [strategies, setStrategies] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    const controller = new AbortController()
    ;(async () => {
      try {
        const res = await fetchWithAbort('/api/backtest/strategies', { signal: controller.signal })
        const data = await res.json()
        if (Array.isArray(data?.strategies)) setStrategies(data.strategies)
        else setError('Failed to load strategies')
      } catch (e) {
        if (e.name === 'AbortError') return
        setError(e.message)
      }
    })()
    return () => controller.abort()
  }, [])
  return { strategies, error }
}

// Schema-rendered parameter controls. Mirrors the Breakout Engine control
// panel UX (range sliders with accent color + live value readout).
export default function StrategyParamsForm({
  strategies, strategyId, onStrategyChange,
  params, onParamsChange,
  costPct, onCostPctChange,
  capitalPerTrade, onCapitalChange,
}) {
  const strategy = strategies?.find(s => s.id === strategyId)
  const labelStyle = { display: 'flex', flexDirection: 'column', gap: '0.3rem', minWidth: '170px' }
  const capStyle = { fontSize: '0.72rem', color: 'var(--text-secondary)' }
  const numInputStyle = {
    background: 'rgba(15, 23, 42, 0.6)', border: '1px solid var(--border)', borderRadius: '6px',
    color: 'var(--text-primary)', padding: '0.35rem 0.5rem', width: '110px', fontSize: '0.85rem',
  }

  if (!strategies) return <div className="glass-panel" style={{ padding: '1rem' }}><p style={{ color: 'var(--text-secondary)' }}>Loading strategies…</p></div>

  return (
    <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem' }}>
      <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <label style={{ ...labelStyle, minWidth: '220px' }}>
          <span style={capStyle}>Strategy</span>
          <select
            value={strategyId}
            onChange={e => onStrategyChange(e.target.value)}
            style={{ ...numInputStyle, width: '220px', cursor: 'pointer' }}
          >
            {strategies.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          {strategy?.description && (
            <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', maxWidth: '220px', lineHeight: 1.4 }}>
              {strategy.description}
            </span>
          )}
        </label>

        <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap', flex: 1 }}>
          {strategy?.paramsSchema?.map(f => {
            const val = params[f.key] ?? strategy.defaults[f.key]
            if (f.type === 'bool') {
              return (
                <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={!!val}
                    onChange={e => onParamsChange({ ...params, [f.key]: e.target.checked })}
                    style={{ accentColor: '#38bdf8', cursor: 'pointer', width: '15px', height: '15px' }}
                  />
                  {f.label}
                </label>
              )
            }
            return (
              <label key={f.key} style={labelStyle}>
                <span style={capStyle}>
                  {f.label}: <strong style={{ color: 'var(--accent)' }}>{Number(val) % 1 === 0 ? val : Number(val).toFixed(1)}</strong>
                </span>
                <input
                  type="range" min={f.min} max={f.max} step={f.step} value={val}
                  onChange={e => onParamsChange({ ...params, [f.key]: +e.target.value })}
                  style={{ accentColor: '#38bdf8', cursor: 'pointer' }}
                />
              </label>
            )
          })}

          <label style={labelStyle}>
            <span style={capStyle}>Cost % (round-trip)</span>
            <input
              type="number" min="0" max="2" step="0.05" value={costPct}
              onChange={e => onCostPctChange(+e.target.value)}
              style={numInputStyle}
            />
          </label>
          <label style={labelStyle}>
            <span style={capStyle}>Capital / trade ₹</span>
            <input
              type="number" min="10000" step="10000" value={capitalPerTrade}
              onChange={e => onCapitalChange(+e.target.value)}
              style={numInputStyle}
            />
          </label>
        </div>
      </div>
    </div>
  )
}
