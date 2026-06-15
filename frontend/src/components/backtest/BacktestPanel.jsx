import { useState, useEffect, useCallback } from 'react'
import { fetchWithAbort } from '../../hooks/useFetchWithAbort'
import StrategyParamsForm, { useStrategies } from './StrategyParamsForm'
import BacktestResults from './BacktestResults'
import PastRunsList from './PastRunsList'

// Single-stock backtest surface — the Instrument page's Backtest tab.
export default function BacktestPanel({ symbol, token }) {
  const { strategies, error: strategiesError } = useStrategies()
  const [strategyId, setStrategyId] = useState('supertrend-swing')
  const [params, setParams] = useState({})
  const [costPct, setCostPct] = useState(0.25)
  const [capitalPerTrade, setCapitalPerTrade] = useState(100000)
  const [result, setResult] = useState(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [saveStatus, setSaveStatus] = useState('idle') // idle | saving | saved | error
  const [runsRefreshKey, setRunsRefreshKey] = useState(0)

  // Reset params to the strategy's defaults whenever the strategy changes.
  useEffect(() => {
    const s = strategies?.find(x => x.id === strategyId)
    if (s) setParams({ ...s.defaults })
  }, [strategies, strategyId])

  const run = useCallback(async () => {
    setRunning(true)
    setError(null)
    setSaveStatus('idle')
    try {
      const res = await fetchWithAbort('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, symbol, strategyId, params, costPct, capitalPerTrade }),
        timeoutMs: 120000, // cold 4Y history fetch takes a few chunked MCP calls
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Backtest failed (${res.status})`)
      setResult(data)
    } catch (e) {
      if (e.name === 'AbortError') return
      setError(e.message)
    } finally {
      setRunning(false)
    }
  }, [token, symbol, strategyId, params, costPct, capitalPerTrade])

  const save = useCallback(async () => {
    if (!result) return
    setSaveStatus('saving')
    try {
      const strategyLabel = strategies?.find(s => s.id === result.strategyId)?.label || result.strategyId
      const res = await fetchWithAbort('/api/backtest/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'single',
          label: `${symbol} · ${strategyLabel}`,
          symbol,
          token,
          strategyId: result.strategyId,
          params: result.params,
          metrics: result.metrics,
          result,
          fromDate: result.fromDate,
          toDate: result.toDate,
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
  }, [result, strategies, symbol, token])

  const loadSavedRun = useCallback((run) => {
    if (run?.result) {
      setResult(run.result)
      setStrategyId(run.strategy_id)
      setParams(run.params || {})
      setSaveStatus('idle')
      setError(null)
    }
  }, [])

  if (!token) return <p style={{ color: 'var(--text-secondary)' }}>No instrument token — open this page from a stock link.</p>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {strategiesError && <p className="negative">{strategiesError}</p>}
      <StrategyParamsForm
        strategies={strategies}
        strategyId={strategyId} onStrategyChange={setStrategyId}
        params={params} onParamsChange={setParams}
        costPct={costPct} onCostPctChange={setCostPct}
        capitalPerTrade={capitalPerTrade} onCapitalChange={setCapitalPerTrade}
      />

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <button
          onClick={run}
          disabled={running || !strategies}
          style={{
            background: running ? 'rgba(56,189,248,0.3)' : 'var(--accent)', color: '#0f172a',
            border: 'none', borderRadius: '8px', padding: '0.55rem 1.5rem',
            fontWeight: 700, cursor: running ? 'wait' : 'pointer', fontSize: '0.9rem',
          }}
        >
          {running ? 'Running… (first run fetches 4Y of data)' : `Run backtest on ${symbol}`}
        </button>
        {result && (
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

      {error && <p className="negative" style={{ margin: 0 }}>{error}</p>}

      {result && (
        <BacktestResults
          metrics={result.metrics}
          equityCurve={result.equityCurve}
          buyHoldCurve={result.buyHoldCurve}
          trades={result.trades}
          openPosition={result.openPosition}
          fromDate={result.fromDate}
          toDate={result.toDate}
        />
      )}

      <h3 style={{ margin: '0.5rem 0 0' }}>Saved runs for {symbol}</h3>
      <PastRunsList kind="single" symbol={symbol} onLoad={loadSavedRun} refreshKey={runsRefreshKey} />
    </div>
  )
}
