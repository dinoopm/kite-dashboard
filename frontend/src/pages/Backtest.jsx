import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { fetchWithAbort } from '../hooks/useFetchWithAbort'
import StrategyParamsForm, { useStrategies } from '../components/backtest/StrategyParamsForm'
import BacktestResults from '../components/backtest/BacktestResults'
import PastRunsList from '../components/backtest/PastRunsList'

const POLL_MS = 2000
const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`)
const pnlClass = (v) => (v == null ? '' : v > 0 ? 'positive' : v < 0 ? 'negative' : '')

// Sortable per-stock breakdown for a basket run.
function PerStockTable({ rows }) {
  const [sort, setSort] = useState({ key: 'totalReturnPct', dir: 'desc' })
  const sorted = useMemo(() => {
    const arr = [...(rows || [])]
    arr.sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key]
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv
      return sort.dir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [rows, sort])

  const header = (key, label, align = 'right') => (
    <th
      onClick={() => setSort(s => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}
      style={{ cursor: 'pointer', textAlign: align, fontSize: '0.75rem', whiteSpace: 'nowrap', userSelect: 'none' }}
    >
      {label}{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  )
  const td = { textAlign: 'right', fontSize: '0.85rem', padding: '0.55rem 0.9rem', whiteSpace: 'nowrap' }

  return (
    <div className="glass-panel" style={{ padding: '0.5rem 1rem 1rem', overflowX: 'auto' }}>
      <table>
        <thead>
          <tr>
            {header('symbol', 'Symbol', 'left')}
            {header('trades', 'Trades')}
            {header('winRate', 'Win %')}
            {header('profitFactor', 'PF')}
            {header('totalReturnPct', 'Return')}
            {header('cagr', 'CAGR')}
            {header('maxDrawdownPct', 'Max DD')}
            {header('buyHoldReturnPct', 'B&H')}
            {header('totalPnl', 'P&L ₹')}
          </tr>
        </thead>
        <tbody>
          {sorted.map(r => (
            <tr key={r.symbol}>
              <td style={{ ...td, textAlign: 'left' }}>
                <Link to={`/instrument/${r.token}?symbol=${encodeURIComponent(r.symbol)}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>
                  {r.symbol}
                </Link>
                {r.openPosition && <span title="Open position at data end" style={{ marginLeft: '0.4rem', color: '#fbbf24', fontSize: '0.7rem' }}>● open</span>}
              </td>
              <td style={td}>{r.trades}</td>
              <td style={td}>{r.winRate != null ? `${r.winRate}%` : '—'}</td>
              <td style={td}>{r.profitFactor ?? '—'}</td>
              <td style={td} className={pnlClass(r.totalReturnPct)}>{fmtPct(r.totalReturnPct)}</td>
              <td style={td} className={pnlClass(r.cagr)}>{fmtPct(r.cagr)}</td>
              <td style={td} className="negative">{fmtPct(r.maxDrawdownPct)}</td>
              <td style={td} className={pnlClass(r.buyHoldReturnPct)}>{fmtPct(r.buyHoldReturnPct)}</td>
              <td style={td} className={pnlClass(r.totalPnl)}>{r.totalPnl > 0 ? '+' : ''}{Number(r.totalPnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function Backtest() {
  const { strategies, error: strategiesError } = useStrategies()
  const [strategyId, setStrategyId] = useState('supertrend-swing')
  const [params, setParams] = useState({})
  const [costPct, setCostPct] = useState(0.25)
  const [capitalPerTrade, setCapitalPerTrade] = useState(100000)

  const [scopeType, setScopeType] = useState('holdings') // holdings | sector | theme
  const [sectors, setSectors] = useState([])
  const [themes, setThemes] = useState([])
  const [sectorKey, setSectorKey] = useState('')
  const [themeId, setThemeId] = useState('')

  const [jobStatus, setJobStatus] = useState(null) // null | running | done | error
  const [progress, setProgress] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [saveStatus, setSaveStatus] = useState('idle')
  const [runsRefreshKey, setRunsRefreshKey] = useState(0)
  const pollTimer = useRef(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
  }, [])

  // Reset params to strategy defaults on strategy change.
  useEffect(() => {
    const s = strategies?.find(x => x.id === strategyId)
    if (s) setParams({ ...s.defaults })
  }, [strategies, strategyId])

  // Scope dropdown data.
  useEffect(() => {
    const controller = new AbortController()
    ;(async () => {
      try {
        const res = await fetchWithAbort('/api/sectors', { signal: controller.signal })
        const data = await res.json()
        if (Array.isArray(data?.sectors)) {
          setSectors(data.sectors)
          if (data.sectors.length > 0) setSectorKey(s => s || data.sectors[0])
        }
      } catch (e) { if (e.name !== 'AbortError') console.error('sectors fetch:', e.message) }
    })()
    ;(async () => {
      try {
        const res = await fetchWithAbort('/api/themes', { signal: controller.signal })
        const data = await res.json()
        if (Array.isArray(data?.themes)) {
          setThemes(data.themes)
          if (data.themes.length > 0) setThemeId(t => t || data.themes[0].id)
        }
      } catch (e) { if (e.name !== 'AbortError') console.error('themes fetch:', e.message) }
    })()
    return () => controller.abort()
  }, [])

  const poll = useCallback(async (jobId) => {
    if (!mountedRef.current) return
    try {
      const res = await fetchWithAbort(`/api/backtest/basket/${jobId}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Poll failed (${res.status})`)
      if (!mountedRef.current) return
      setProgress(data.progress)
      if (data.status === 'done') {
        setResult(data.result)
        setJobStatus('done')
        return
      }
      if (data.status === 'error') {
        setError(data.error || 'Basket backtest failed')
        setJobStatus('error')
        return
      }
      pollTimer.current = setTimeout(() => poll(jobId), POLL_MS)
    } catch (e) {
      if (!mountedRef.current) return
      // Transient poll failure — keep trying; the job is still running server-side.
      pollTimer.current = setTimeout(() => poll(jobId), POLL_MS * 2)
    }
  }, [])

  const run = useCallback(async () => {
    const scope = scopeType === 'sector' ? { type: 'sector', sectorKey }
      : scopeType === 'theme' ? { type: 'theme', themeId }
      : { type: 'holdings' }
    if (scopeType === 'sector' && !sectorKey) { setError('Pick a sector'); return }
    if (scopeType === 'theme' && !themeId) { setError('Pick a theme'); return }

    setError(null)
    setResult(null)
    setSaveStatus('idle')
    setJobStatus('running')
    setProgress({ loaded: 0, total: 0, symbol: null })
    try {
      const res = await fetchWithAbort('/api/backtest/basket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, strategyId, params, costPct, capitalPerTrade }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed to start (${res.status})`)
      poll(data.jobId)
    } catch (e) {
      setError(e.message)
      setJobStatus('error')
    }
  }, [scopeType, sectorKey, themeId, strategyId, params, costPct, capitalPerTrade, poll])

  const save = useCallback(async () => {
    if (!result) return
    setSaveStatus('saving')
    try {
      const strategyLabel = strategies?.find(s => s.id === result.strategyId)?.label || result.strategyId
      const res = await fetchWithAbort('/api/backtest/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'basket',
          label: `${result.label} · ${strategyLabel}`,
          scope: result.scope,
          strategyId: result.strategyId,
          params: result.params,
          metrics: result.aggregate.metrics,
          result,
          fromDate: result.perStock?.[0]?.fromDate || null,
          toDate: result.perStock?.[0]?.toDate || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`)
      setSaveStatus('saved')
      setRunsRefreshKey(k => k + 1)
    } catch (e) {
      setError(e.message)
      setSaveStatus('error')
    }
  }, [result, strategies])

  const loadSavedRun = useCallback((run) => {
    if (run?.result) {
      setResult(run.result)
      setStrategyId(run.strategy_id)
      setParams(run.params || {})
      setJobStatus('done')
      setSaveStatus('idle')
      setError(null)
    }
  }, [])

  const selStyle = {
    background: 'rgba(15, 23, 42, 0.6)', border: '1px solid var(--border)', borderRadius: '6px',
    color: 'var(--text-primary)', padding: '0.4rem 0.6rem', fontSize: '0.85rem', cursor: 'pointer',
  }
  const scopeBtn = (type, label) => (
    <button
      onClick={() => setScopeType(type)}
      style={{
        background: scopeType === type ? 'var(--accent)' : 'transparent',
        color: scopeType === type ? '#0f172a' : 'var(--text-secondary)',
        border: `1px solid ${scopeType === type ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: '8px', padding: '0.45rem 1.1rem', cursor: 'pointer',
        fontWeight: scopeType === type ? 700 : 400, fontSize: '0.85rem',
      }}
    >
      {label}
    </button>
  )

  const running = jobStatus === 'running'
  const pct = progress && progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0

  return (
    <div>
      <h1 style={{ marginBottom: '0.25rem' }}>Strategy Backtester</h1>
      <p style={{ color: 'var(--text-secondary)', marginTop: 0, marginBottom: '1.5rem', fontSize: '0.9rem' }}>
        Replay a strategy across a whole basket — your holdings, a sector, or a theme — over up to 4 years of daily data.
        Equal-weight: each stock gets its own capital allocation.
      </p>

      {strategiesError && <p className="negative">{strategiesError}</p>}

      <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem', display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Universe</span>
        {scopeBtn('holdings', 'My Holdings')}
        {scopeBtn('sector', 'Sector')}
        {scopeBtn('theme', 'Theme')}
        {scopeType === 'sector' && (
          <select value={sectorKey} onChange={e => setSectorKey(e.target.value)} style={selStyle}>
            {sectors.map(s => <option key={s} value={s}>{s.replace(/^NSE:/, '')}</option>)}
          </select>
        )}
        {scopeType === 'theme' && (
          themes.length > 0 ? (
            <select value={themeId} onChange={e => setThemeId(e.target.value)} style={selStyle}>
              {themes.map(t => <option key={t.id} value={t.id}>{t.name} ({t.instrumentCount})</option>)}
            </select>
          ) : <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>No themes yet — create one on the Basket page.</span>
        )}
      </div>

      <StrategyParamsForm
        strategies={strategies}
        strategyId={strategyId} onStrategyChange={setStrategyId}
        params={params} onParamsChange={setParams}
        costPct={costPct} onCostPctChange={setCostPct}
        capitalPerTrade={capitalPerTrade} onCapitalChange={setCapitalPerTrade}
      />

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem' }}>
        <button
          onClick={run}
          disabled={running || !strategies}
          style={{
            background: running ? 'rgba(56,189,248,0.3)' : 'var(--accent)', color: '#0f172a',
            border: 'none', borderRadius: '8px', padding: '0.55rem 1.5rem',
            fontWeight: 700, cursor: running ? 'wait' : 'pointer', fontSize: '0.9rem',
          }}
        >
          {running ? 'Running…' : 'Run basket backtest'}
        </button>
        {result && jobStatus === 'done' && (
          <button
            onClick={save}
            disabled={saveStatus === 'saving' || saveStatus === 'saved'}
            style={{
              background: 'transparent', border: '1px solid var(--accent)', color: 'var(--accent)',
              borderRadius: '8px', padding: '0.5rem 1.25rem', cursor: 'pointer', fontSize: '0.85rem',
            }}
          >
            {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? '✓ Saved' : 'Save run'}
          </button>
        )}
      </div>

      {running && (
        <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
            <span>
              {progress?.total ? `Backtesting ${progress.loaded}/${progress.total}` : 'Resolving constituents…'}
              {progress?.symbol ? ` — ${progress.symbol}` : ''}
            </span>
            <span>{pct}%</span>
          </div>
          <div style={{ height: '8px', background: 'rgba(255,255,255,0.08)', borderRadius: '4px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', borderRadius: '4px', transition: 'width 0.4s' }} />
          </div>
          <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: '0.5rem 0 0' }}>
            Cold instruments need rate-limited 4-year history fetches (~4s each) — warm caches finish instantly.
          </p>
        </div>
      )}

      {error && <p className="negative">{error}</p>}

      {result && jobStatus === 'done' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h2 style={{ margin: 0 }}>
            {result.label}
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 400, marginLeft: '0.75rem' }}>
              {result.perStock.length} stocks{result.skipped?.length ? ` · ${result.skipped.length} skipped (${result.skipped.join(', ')})` : ''}
            </span>
          </h2>
          <BacktestResults
            metrics={result.aggregate.metrics}
            equityCurve={result.aggregate.equityCurve}
            buyHoldCurve={result.aggregate.buyHoldCurve}
            trades={null}
            fromDate={result.perStock?.[0]?.fromDate}
            toDate={result.perStock?.[0]?.toDate}
          />
          <h3 style={{ margin: '0.25rem 0 0' }}>Per-stock breakdown</h3>
          <PerStockTable rows={result.perStock} />
        </div>
      )}

      <h3 style={{ margin: '1.5rem 0 0.75rem' }}>Saved basket runs</h3>
      <PastRunsList kind="basket" onLoad={loadSavedRun} refreshKey={runsRefreshKey} />
    </div>
  )
}
