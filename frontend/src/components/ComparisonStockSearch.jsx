import { useEffect, useId, useState } from 'react'
import { fetchWithAbort } from '../hooks/useFetchWithAbort'
import { comparisonSearchUrl, parseComparisonStocks } from '../lib/comparisonStock'

export default function ComparisonStockSearch({ model }) {
  const { market, exclude, instrument, choose } = model
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState({ query: '', rows: [], loading: false, error: null })
  const listId = useId()
  const trimmed = query.trim()

  useEffect(() => {
    if (trimmed.length < 2) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setResult({ query: trimmed, rows: [], loading: true, error: null })
      try {
        const response = await fetchWithAbort(comparisonSearchUrl(market, trimmed), { signal: controller.signal })
        const payload = await response.json()
        if (!response.ok) throw new Error(payload.error || `Stock search failed (${response.status})`)
        const rows = parseComparisonStocks(payload, market, exclude)
        if (!controller.signal.aborted) setResult({ query: trimmed, rows, loading: false, error: null })
      } catch (error) {
        if (!controller.signal.aborted) setResult({ query: trimmed, rows: [], loading: false,
          error: error.name === 'RateLimitedError' ? 'Rate limited. Please wait before retrying.' : error.message })
      }
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [trimmed, market, exclude, attempt])

  const searching = result.query !== trimmed || result.loading
  const rows = searching ? [] : result.rows
  const expanded = open && trimmed.length >= 2
  const select = stock => { choose(stock); setQuery(''); setOpen(false); setActive(0) }
  const onKeyDown = event => {
    if (event.key === 'Escape') { setOpen(false); return }
    if (!expanded || !rows.length) return
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(value => Math.min(value + 1, rows.length - 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(value => Math.max(value - 1, 0)) }
    else if (event.key === 'Enter') { event.preventDefault(); select(rows[Math.min(active, rows.length - 1)]) }
  }

  return <div style={{ marginTop: '0.75rem', maxWidth: '520px' }}>
    {instrument && <div style={{ fontSize: '0.8rem', marginBottom: '0.5rem', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
      <span><span style={{ color: '#60a5fa' }}>━</span> Comparing <strong>{instrument.symbol}</strong>{instrument.exchange ? ` · ${instrument.exchange}` : ''}</span>
      <button type="button" onClick={() => { choose(null); setQuery(''); setOpen(false) }}>Clear stock</button>
    </div>}
    <label style={{ display: 'block', fontSize: '0.8rem' }}>
      Search {market === 'US' ? 'US' : 'Indian'} stock to compare
      <input role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={listId}
        aria-activedescendant={expanded && rows.length ? `${listId}-${Math.min(active, rows.length - 1)}` : undefined}
        value={query} placeholder="Symbol or company name…" onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
        onChange={event => { setQuery(event.target.value); setOpen(true); setActive(0) }}
        style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: '0.35rem', padding: '0.6rem 0.75rem', border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg-dark)', color: 'var(--text-primary)' }} />
    </label>
    {expanded && <div style={{ marginTop: '0.35rem', border: '1px solid var(--border)', borderRadius: '6px', maxHeight: '240px', overflowY: 'auto' }}>
      <div role="status" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
        {searching ? 'Searching…' : result.error ? <><span>{result.error}</span> <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry stock search</button></> : !rows.length ? 'No matching stocks. Try another symbol or company name.' : null}
      </div>
      <div role="listbox" id={listId} aria-label="Stock search results">
        {rows.map((stock, index) => <button type="button" role="option" id={`${listId}-${index}`} tabIndex={-1}
          aria-selected={index === active} key={stock.token || stock.symbol} onClick={() => select(stock)}
          style={{ display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', padding: '0.6rem 0.75rem', border: 0, borderBottom: '1px solid var(--border)', background: index === active ? 'rgba(56,189,248,0.1)' : 'var(--bg-panel)', color: 'var(--text-primary)' }}>
          <strong>{stock.symbol}</strong> · {stock.exchange} <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{stock.name}</span>
        </button>)}
      </div>
    </div>}
    {!instrument && <div style={{ fontSize: '0.75rem', marginTop: '0.35rem', color: 'var(--text-secondary)' }}>Enter at least two characters and select a result to add its comparison line.</div>}
  </div>
}
