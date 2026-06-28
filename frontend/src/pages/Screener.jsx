import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { fetchWithAbort } from '../hooks/useFetchWithAbort'

const POLL_MS = 2000
const NUMBER_OPS = [
  { v: 'gt', label: '>' }, { v: 'gte', label: '≥' },
  { v: 'lt', label: '<' }, { v: 'lte', label: '≤' },
]
const ENUM_OPS = [{ v: 'is', label: 'is' }, { v: 'isnot', label: 'is not' }]

// Columns shown in the results table (subset of the field catalog, in order).
const RESULT_COLUMNS = [
  { key: 'price', label: 'Price ₹' },
  { key: 'change1D', label: '1D %', pct: true },
  { key: 'rsi14', label: 'RSI' },
  { key: 'adx14', label: 'ADX' },
  { key: 'volSurge', label: 'Vol×' },
  { key: 'signal1050', label: '10/50 Signal' },
  { key: 'signal1050Age', label: 'Sig. age' },
  { key: 'supertrend', label: 'SuperTrend' },
  { key: 'pctVsSma200', label: 'vs 200SMA %', pct: true },
  { key: 'ret1M', label: '1M %', pct: true },
  { key: 'ret1Y', label: '1Y %', pct: true },
  { key: 'dist20dHigh', label: '20dH %', pct: true },
  { key: 'dist52wHigh', label: '52wH %', pct: true },
]

const inputStyle = {
  background: 'rgba(15, 23, 42, 0.6)', border: '1px solid var(--border)', borderRadius: '6px',
  color: 'var(--text-primary)', padding: '0.4rem 0.6rem', fontSize: '0.85rem',
}
const pnlClass = (v) => (v == null ? '' : v > 0 ? 'positive' : v < 0 ? 'negative' : '')

// CSV cell escaping: quote if the value contains a comma, quote, or newline.
const csvEscape = (val) => {
  if (val == null) return ''
  const s = String(val)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// Export the (already sorted) result rows to a CSV file download. Numeric values
// are written raw — no +/% decoration — so they stay usable in spreadsheets.
function exportMatchesCsv(rows, label) {
  const headers = ['Symbol', 'Name', 'Sector', 'Industry', ...RESULT_COLUMNS.map(c => c.label)]
  const lines = [headers.map(csvEscape).join(',')]
  for (const m of rows) {
    const cells = [m.symbol, m.name || '', m.sector || '', m.industry || '', ...RESULT_COLUMNS.map(c => m.values[c.key])]
    lines.push(cells.map(csvEscape).join(','))
  }
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const slug = (label || 'results').replace(/^NSE:/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  a.href = url
  a.download = `screener-${slug}-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// One editable condition row: field → operator → value.
function ConditionRow({ cond, fields, onChange, onRemove }) {
  const field = fields.find(f => f.key === cond.field)
  const ops = field?.type === 'enum' ? ENUM_OPS : NUMBER_OPS
  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
      <select
        value={cond.field}
        onChange={e => {
          const f = fields.find(x => x.key === e.target.value)
          onChange({
            field: f.key,
            op: f.type === 'enum' ? 'is' : 'gt',
            value: f.type === 'enum' ? f.enumValues[0] : 0,
          })
        }}
        style={{ ...inputStyle, cursor: 'pointer', minWidth: '200px' }}
      >
        {Object.entries(fields.reduce((g, f) => { (g[f.group] = g[f.group] || []).push(f); return g }, {})).map(([group, fs]) => (
          <optgroup key={group} label={group}>
            {fs.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
          </optgroup>
        ))}
      </select>
      <select
        value={cond.op}
        onChange={e => onChange({ ...cond, op: e.target.value })}
        style={{ ...inputStyle, cursor: 'pointer', width: '80px' }}
      >
        {ops.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
      {field?.type === 'enum' ? (
        <select
          value={cond.value}
          onChange={e => onChange({ ...cond, value: e.target.value })}
          style={{ ...inputStyle, cursor: 'pointer', width: '110px' }}
        >
          {field.enumValues.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      ) : (
        <input
          type="number" step="any" value={cond.value}
          onChange={e => onChange({ ...cond, value: e.target.value === '' ? '' : +e.target.value })}
          style={{ ...inputStyle, width: '110px' }}
        />
      )}
      <button
        onClick={onRemove}
        title="Remove condition"
        style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', padding: '0.3rem 0.6rem', cursor: 'pointer', fontSize: '0.8rem' }}
      >
        ✕
      </button>
    </div>
  )
}

function ResultsTable({ matches, label }) {
  const [sort, setSort] = useState({ key: 'change1D', dir: 'desc' })
  const sorted = useMemo(() => {
    const arr = [...(matches || [])]
    arr.sort((a, b) => {
      const pick = (x) => sort.key === 'symbol' ? x.symbol : sort.key === 'sector' ? (x.sector || '') : x.values[sort.key]
      const av = pick(a)
      const bv = pick(b)
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv
      return sort.dir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [matches, sort])

  const header = (key, label, align = 'right') => (
    <th
      key={key}
      onClick={() => setSort(s => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}
      style={{ cursor: 'pointer', textAlign: align, fontSize: '0.75rem', whiteSpace: 'nowrap', userSelect: 'none' }}
    >
      {label}{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  )
  const td = { textAlign: 'right', fontSize: '0.85rem', padding: '0.55rem 0.9rem', whiteSpace: 'nowrap' }

  return (
    <div className="glass-panel" style={{ padding: '0.5rem 1rem 1rem', overflowX: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0.4rem 0 0.2rem' }}>
        <button
          onClick={() => exportMatchesCsv(sorted, label)}
          disabled={sorted.length === 0}
          title="Download matches as CSV"
          style={{
            background: 'transparent', border: '1px solid var(--accent)', color: 'var(--accent)',
            borderRadius: '6px', padding: '0.3rem 0.9rem', cursor: 'pointer', fontSize: '0.78rem',
            whiteSpace: 'nowrap',
          }}
        >
          ↓ Export CSV
        </button>
      </div>
      <table>
        <thead>
          <tr>
            {header('symbol', 'Symbol', 'left')}
            {header('sector', 'Sector', 'left')}
            {RESULT_COLUMNS.map(c => header(c.key, c.label))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(m => (
            <tr key={m.symbol}>
              <td style={{ ...td, textAlign: 'left' }}>
                <Link to={`/instrument/${m.token}?symbol=${encodeURIComponent(m.symbol)}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>
                  {m.symbol}
                </Link>
                {m.name && m.name !== m.symbol && <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>}
              </td>
              <td style={{ ...td, textAlign: 'left' }} title={m.industry || ''}>
                {m.sector
                  ? <span style={{ fontSize: '0.8rem' }}>{m.sector}</span>
                  : <span style={{ color: 'var(--text-secondary)' }}>—</span>}
                {m.industry && <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.industry}</div>}
              </td>
              {RESULT_COLUMNS.map(c => {
                const v = m.values[c.key]
                if (v == null) return <td key={c.key} style={td}>—</td>
                if (c.key === 'supertrend' || c.key === 'signal1050') {
                  const color = (v === 'BULL' || v === 'BUY') ? '#22c55e' : (v === 'BEAR' || v === 'SELL') ? '#ef4444' : 'var(--text-secondary)'
                  return <td key={c.key} style={{ ...td, color, fontWeight: 600 }}>{v}</td>
                }
                return (
                  <td key={c.key} style={td} className={c.pct ? pnlClass(v) : ''}>
                    {typeof v === 'number' ? `${c.pct && v > 0 ? '+' : ''}${v}${c.pct ? '%' : ''}` : v}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function Screener() {
  const [fields, setFields] = useState(null)
  // Default screen: fast SMA(10)/slow SMA(50) crossover says BUY (same engine
  // as the Signals tab) and price is breaking out above its prior 20d high.
  const [conditions, setConditions] = useState([
    { field: 'signal1050', op: 'is', value: 'BUY' },
    { field: 'breakout20d', op: 'is', value: 'YES' },
  ])

  const [scopeType, setScopeType] = useState('holdings')
  const [sectors, setSectors] = useState([])
  const [themes, setThemes] = useState([])
  const [sectorKey, setSectorKey] = useState('')
  const [themeId, setThemeId] = useState('')

  const [jobStatus, setJobStatus] = useState(null)
  const [progress, setProgress] = useState(null)
  const [result, setResult] = useState(null)
  const [partial, setPartial] = useState([]) // matches streamed in while still scanning
  const [error, setError] = useState(null)

  const [screens, setScreens] = useState(null)
  const [screenName, setScreenName] = useState('')
  const [saveStatus, setSaveStatus] = useState('idle')
  const [activeScreenId, setActiveScreenId] = useState(null)

  const pollTimer = useRef(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
  }, [])

  // Field catalog + scope dropdowns + saved screens.
  useEffect(() => {
    const controller = new AbortController()
    const get = async (url, set, key) => {
      try {
        const res = await fetchWithAbort(url, { signal: controller.signal })
        const data = await res.json()
        if (data?.[key]) set(data[key])
      } catch (e) { if (e.name !== 'AbortError') console.error(url, e.message) }
    }
    get('/api/screener/fields', setFields, 'fields')
    get('/api/sectors', (s) => { setSectors(s); setSectorKey(k => k || s[0] || '') }, 'sectors')
    get('/api/themes', (t) => { setThemes(t); setThemeId(id => id || t[0]?.id || '') }, 'themes')
    get('/api/screener/screens', setScreens, 'screens')
    return () => controller.abort()
  }, [])

  const poll = useCallback(async (jobId) => {
    if (!mountedRef.current) return
    try {
      const res = await fetchWithAbort(`/api/screener/run/${jobId}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Poll failed (${res.status})`)
      if (!mountedRef.current) return
      setProgress(data.progress)
      if (Array.isArray(data.partialMatches)) setPartial(data.partialMatches)
      if (data.status === 'done') { setResult(data.result); setJobStatus('done'); return }
      if (data.status === 'error') { setError(data.error || 'Screen failed'); setJobStatus('error'); return }
      pollTimer.current = setTimeout(() => poll(jobId), POLL_MS)
    } catch {
      if (!mountedRef.current) return
      pollTimer.current = setTimeout(() => poll(jobId), POLL_MS * 2)
    }
  }, [])

  const buildScope = useCallback(() => (
    scopeType === 'sector' ? { type: 'sector', sectorKey }
      : scopeType === 'theme' ? { type: 'theme', themeId }
      : { type: 'holdings' }
  ), [scopeType, sectorKey, themeId])

  const run = useCallback(async () => {
    if (scopeType === 'sector' && !sectorKey) { setError('Pick a sector'); return }
    if (scopeType === 'theme' && !themeId) { setError('Pick a theme'); return }
    setError(null)
    setResult(null)
    setPartial([])
    setJobStatus('running')
    setProgress({ loaded: 0, total: 0, symbol: null })
    try {
      const res = await fetchWithAbort('/api/screener/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: buildScope(), conditions }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed to start (${res.status})`)
      poll(data.jobId)
    } catch (e) {
      setError(e.message)
      setJobStatus('error')
    }
  }, [scopeType, sectorKey, themeId, conditions, buildScope, poll])

  const saveScreen = useCallback(async () => {
    const name = screenName.trim()
    if (!name) { setError('Give the screen a name first'); return }
    setSaveStatus('saving')
    setError(null)
    try {
      const res = await fetchWithAbort('/api/screener/screens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, scope: buildScope(), conditions }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`)
      setScreens(s => [data.screen, ...(s || [])])
      setScreenName('')
      setSaveStatus('saved')
    } catch (e) {
      setError(e.message)
      setSaveStatus('error')
    }
  }, [screenName, conditions, buildScope])

  const loadScreen = useCallback((screen) => {
    setConditions(screen.conditions)
    const sc = screen.scope || {}
    setScopeType(sc.type || 'holdings')
    if (sc.sectorKey) setSectorKey(sc.sectorKey)
    if (sc.themeId) setThemeId(sc.themeId)
    setResult(null)
    setJobStatus(null)
    setError(null)
    setActiveScreenId(screen.id)
  }, [])

  const deleteScreen = useCallback(async (id) => {
    if (!window.confirm('Delete this saved screen?')) return
    try {
      const res = await fetchWithAbort(`/api/screener/screens/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`Delete failed (${res.status})`)
      setScreens(s => (s || []).filter(x => x.id !== id))
      setActiveScreenId(cur => (cur === id ? null : cur))
    } catch (e) { setError(e.message) }
  }, [])

  const describeCondition = useCallback((c) => {
    const f = fields?.find(x => x.key === c.field)
    const op = [...NUMBER_OPS, ...ENUM_OPS].find(o => o.v === c.op)
    return `${f?.label || c.field} ${op?.label || c.op} ${c.value}`
  }, [fields])

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
      <h1 style={{ marginBottom: '0.25rem' }}>Custom Screener</h1>
      <p style={{ color: 'var(--text-secondary)', marginTop: 0, marginBottom: '1.5rem', fontSize: '0.9rem' }}>
        Scan your holdings, a sector, or a theme against indicator conditions — all conditions must match.
        Same math as the alert engine (RSI, ADX, SuperTrend, SMA/EMA, volume).
      </p>

      <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem', display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Universe</span>
        {scopeBtn('holdings', 'My Holdings')}
        {scopeBtn('sector', 'Sector')}
        {scopeBtn('theme', 'Theme')}
        {scopeType === 'sector' && (
          <select value={sectorKey} onChange={e => setSectorKey(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
            {sectors.map(s => <option key={s} value={s}>{s.replace(/^NSE:/, '')}</option>)}
          </select>
        )}
        {scopeType === 'theme' && (
          themes.length > 0 ? (
            <select value={themeId} onChange={e => setThemeId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
              {themes.map(t => <option key={t.id} value={t.id}>{t.name} ({t.instrumentCount})</option>)}
            </select>
          ) : <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>No themes yet — create one on the Basket page.</span>
        )}
      </div>

      <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Conditions (all must match)
        </span>
        {!fields ? <p style={{ color: 'var(--text-secondary)', margin: 0 }}>Loading fields…</p> : (
          <>
            {conditions.map((c, i) => (
              <ConditionRow
                key={i}
                cond={c}
                fields={fields}
                onChange={next => { setConditions(cs => cs.map((x, j) => (j === i ? next : x))); setActiveScreenId(null) }}
                onRemove={() => { setConditions(cs => cs.filter((_, j) => j !== i)); setActiveScreenId(null) }}
              />
            ))}
            <div>
              <button
                onClick={() => { setConditions(cs => [...cs, { field: 'rsi14', op: 'lt', value: 30 }]); setActiveScreenId(null) }}
                disabled={conditions.length >= 12}
                style={{ background: 'transparent', border: '1px dashed var(--border)', color: 'var(--accent)', borderRadius: '8px', padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.82rem' }}
              >
                + Add condition
              </button>
            </div>
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <button
          onClick={run}
          disabled={running || !fields || conditions.length === 0}
          style={{
            background: running ? 'rgba(56,189,248,0.3)' : 'var(--accent)', color: '#0f172a',
            border: 'none', borderRadius: '8px', padding: '0.55rem 1.5rem',
            fontWeight: 700, cursor: running ? 'wait' : 'pointer', fontSize: '0.9rem',
          }}
        >
          {running ? 'Scanning…' : 'Run screen'}
        </button>
        <input
          placeholder="Screen name…"
          value={screenName}
          onChange={e => { setScreenName(e.target.value); setSaveStatus('idle') }}
          style={{ ...inputStyle, width: '180px' }}
        />
        <button
          onClick={saveScreen}
          disabled={saveStatus === 'saving' || !screenName.trim()}
          style={{
            background: 'transparent', border: '1px solid var(--accent)', color: 'var(--accent)',
            borderRadius: '8px', padding: '0.5rem 1.25rem', cursor: 'pointer', fontSize: '0.85rem',
          }}
        >
          {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? '✓ Saved' : 'Save screen'}
        </button>
      </div>

      {running && (
        <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
            <span>
              {progress?.total ? `Scanning ${progress.loaded}/${progress.total}` : 'Resolving constituents…'}
              {progress?.symbol ? ` — ${progress.symbol}` : ''}
            </span>
            <span>{pct}%</span>
          </div>
          <div style={{ height: '8px', background: 'rgba(255,255,255,0.08)', borderRadius: '4px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', borderRadius: '4px', transition: 'width 0.4s' }} />
          </div>
          <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: '0.5rem 0 0' }}>
            Cold instruments need rate-limited history fetches — warm caches scan instantly.
          </p>
        </div>
      )}

      {running && partial.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.5rem' }}>
          <h2 style={{ margin: 0 }}>
            {partial.length} match{partial.length === 1 ? '' : 'es'} so far
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 400, marginLeft: '0.75rem' }}>
              still scanning… (sectors resolve when the scan finishes)
            </span>
          </h2>
          <ResultsTable matches={partial} label={progress?.label || 'scan'} />
        </div>
      )}

      {error && <p className="negative">{error}</p>}

      {result && jobStatus === 'done' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.5rem' }}>
          <h2 style={{ margin: 0 }}>
            {result.matches.length} match{result.matches.length === 1 ? '' : 'es'}
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 400, marginLeft: '0.75rem' }}>
              of {result.scanned} scanned in {result.label?.replace(/^NSE:/, '')}
              {result.notReady?.length ? ` · ${result.notReady.length} unavailable (${result.notReady.join(', ')})` : ''}
            </span>
          </h2>
          {result.matches.length > 0
            ? <ResultsTable matches={result.matches} label={result.label} />
            : <p style={{ color: 'var(--text-secondary)' }}>No stocks matched all conditions.</p>}
        </div>
      )}

      <h3 style={{ margin: '0.5rem 0 0.75rem' }}>Saved screens</h3>
      {!screens ? <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Loading…</p>
        : screens.length === 0 ? <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>No saved screens yet.</p>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {screens.map(s => {
              const isActive = s.id === activeScreenId
              return (
              <div
                key={s.id}
                className="glass-panel"
                style={{
                  padding: '0.7rem 1rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap',
                  border: isActive ? '1px solid var(--accent)' : undefined,
                  background: isActive ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : undefined,
                }}
              >
                {isActive && <span style={{ color: 'var(--accent)', fontSize: '0.9rem', lineHeight: 1 }} title="Currently loaded">●</span>}
                <strong style={{ minWidth: '140px' }}>{s.name}</strong>
                {isActive && (
                  <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em', border: '1px solid var(--accent)', borderRadius: '4px', padding: '0.1rem 0.4rem' }}>
                    Loaded
                  </span>
                )}
                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', flex: 1 }}>
                  {(s.scope?.type === 'sector' ? (s.scope.sectorKey || '').replace(/^NSE:/, '') : s.scope?.type) || ''}
                  {' · '}
                  {(s.conditions || []).map(describeCondition).join('  AND  ')}
                </span>
                <button
                  onClick={() => loadScreen(s)}
                  disabled={isActive}
                  style={{
                    background: isActive ? 'var(--accent)' : 'transparent',
                    border: '1px solid var(--accent)',
                    color: isActive ? '#0f172a' : 'var(--accent)',
                    borderRadius: '6px', padding: '0.25rem 0.8rem',
                    cursor: isActive ? 'default' : 'pointer', fontSize: '0.78rem',
                    fontWeight: isActive ? 700 : 400,
                  }}
                >
                  {isActive ? 'Loaded' : 'Load'}
                </button>
                <button
                  onClick={() => deleteScreen(s.id)}
                  style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', padding: '0.25rem 0.8rem', cursor: 'pointer', fontSize: '0.78rem' }}
                >
                  Delete
                </button>
              </div>
              )
            })}
          </div>
        )}
    </div>
  )
}
