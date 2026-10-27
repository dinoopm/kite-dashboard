import { Fragment, useState, useEffect } from 'react'
import EquityDecisionPanel from './EquityDecisionPanel'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'

// US 10-Year Treasury yield (^TNX) chart — the risk-free rate that drives
// equity valuations and FII flows into/out of India. Range-selectable; feeds
// from /api/us/treasury-10y (Yahoo). Pairs with the RiskRegimePanel, which
// reads the same yield as one of its gauges.
const RANGES = ['1M', '3M', '6M', '1Y', '2Y', '3Y', '4Y', '5Y', '10Y', '20Y']
// Ranges spanning more than one calendar year need the year on the tick, or
// "13 May" appears several times along the axis meaning different years.
const MULTI_YEAR = new Set(['2Y', '3Y', '4Y', '5Y', '10Y', '20Y'])
const GREY = 'var(--text-secondary)'

const fmtTick = (t, range) => {
  const d = new Date(t)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: MULTI_YEAR.has(range) ? '2-digit' : undefined })
}
const asOfClock = (iso) => { try { return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET' } catch { return null } }

export default function TreasuryChart() {
  const [range, setRange] = useState('6M')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [annualData, setAnnualData] = useState(null)
  const [annualError, setAnnualError] = useState(null)
  const [expandedYear, setExpandedYear] = useState(null)
  const [macroHistory, setMacroHistory] = useState(null)
  const [macroError, setMacroError] = useState(null)
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/us/treasury-macro-history', { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error('Inflation and Fed rate history unavailable'); return r.json() })
      .then(setMacroHistory)
      .catch(e => { if (e.name !== 'AbortError') setMacroError(e.message) })
    return () => controller.abort()
  }, [])
  const macroCell = (series, period, key) => {
    const point = macroHistory?.[series]?.[period]?.[key]
    return <td title={point ? `Reference month: ${point.month}` : macroError || macroHistory?.[series]?.error || 'Not yet available'} style={{ padding: '0.6rem', textAlign: 'right', whiteSpace: 'nowrap', color: GREY, borderBottom: '1px solid var(--border)' }}>{point ? <>{point.value.toFixed(2)}%{period === 'annual' && <small style={{ display: 'block', fontWeight: 400 }}>{point.month}</small>}</> : !macroHistory && !macroError ? 'Loading…' : '—'}</td>
  }
  const [equityReturns, setEquityReturns] = useState(null)
  const [equityError, setEquityError] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/us/treasury-equity-returns', { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error('Index returns unavailable'); return r.json() })
      .then(setEquityReturns)
      .catch(e => { if (e.name !== 'AbortError') setEquityError(e.message) })
    return () => controller.abort()
  }, [])

  const returnCell = (index, period, key) => {
    const result = equityReturns?.[index]?.[period]?.[key]
    const value = result?.returnPct
    return <td title={result ? `Through ${result.asOf}; price return excluding dividends` : equityError || equityReturns?.[index]?.error || 'No return available'} style={{ padding: '0.6rem', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700, color: value == null || value === 0 ? GREY : value > 0 ? '#34d399' : '#f87171', borderBottom: '1px solid var(--border)' }}>{value == null ? (!equityReturns && !equityError ? 'Loading…' : '—') : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`}</td>
  }

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/us/treasury-10y?range=20Y', { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error('Annual history unavailable'); return r.json() })
      .then(j => {
        if (j.error) throw new Error(j.error)
        if (!j.series?.length) throw new Error('Annual history unavailable')
        setAnnualData(j)
      })
      .catch(e => { if (e.name !== 'AbortError') setAnnualError(e.message) })
    return () => controller.abort()
  }, [])

  const annualPoints = new Map()
  for (const point of annualData?.series || []) {
    const year = new Date(point.t).getUTCFullYear()
    if (!Number.isFinite(year) || !Number.isFinite(point.y)) continue
    if (!annualPoints.has(year) || point.t > annualPoints.get(year).t) annualPoints.set(year, point)
  }
  const monthlyPoints = new Map()
  for (const point of annualData?.series || []) {
    if (!Number.isFinite(point.y) || !Number.isFinite(Date.parse(point.t))) continue
    const key = point.t.slice(0, 7)
    if (!monthlyPoints.has(key) || point.t > monthlyPoints.get(key).t) monthlyPoints.set(key, point)
  }
  const monthlyRows = Array.from({ length: 12 }, (_, month) => {
    const key = `${expandedYear}-${String(month + 1).padStart(2, '0')}`
    const previousKey = month === 0 ? `${expandedYear - 1}-12` : `${expandedYear}-${String(month).padStart(2, '0')}`
    const point = monthlyPoints.get(key)
    const previous = monthlyPoints.get(previousKey)
    const latestKey = annualData?.series?.at(-1)?.t.slice(0, 7)
    const value = point ? (key === latestKey ? annualData.current ?? point.y : point.y) : null
    return { key, month, point, previous, value, current: key === latestKey, change: value != null && previous ? Math.round((value - previous.y) * 100) : null }
  }).filter(row => row.point)
  const toggleYear = year => setExpandedYear(current => current === year ? null : year)
  const latestYear = Math.max(...annualPoints.keys())
  const annualRows = [...annualPoints.entries()].sort(([a], [b]) => b - a).map(([year, point]) => {
    const previous = annualPoints.get(year - 1)
    const yieldValue = year === latestYear ? (annualData.current ?? point.y) : point.y
    return { year, point, yieldValue, previous, change: previous ? Math.round((yieldValue - previous.y) * 100) : null }
  })

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
      <section aria-label="Treasury yield year-over-year changes" style={{ marginTop: '1.2rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
        <h3 style={{ fontSize: '0.9rem', margin: '0 0 0.4rem' }}>Year-over-year changes · past 20 years</h3>
        <p style={{ fontSize: '0.72rem', color: GREY, margin: '0 0 0.8rem' }}>
          Latest available observation in each year versus the previous year. The latest year is year to date; historical values use weekly chart observations. 100 bps = 1 percentage point. Click a year to see monthly changes. Equity columns show calendar-year/month price returns excluding dividends, using daily closes; current periods are to date. Hover a return for its data date.
        </p>
        <p style={{ color: GREY, fontSize: '0.72rem' }}>Inflation: headline CPI-U change from the same month a year earlier (not seasonally adjusted). Fed rate: monthly average effective federal funds rate, rather than the target range. Annual rows use December or the latest published month shown. Unpublished months appear as —. Source: FRED / BLS / Federal Reserve.</p>
        {(macroError || macroHistory?.inflation?.error || macroHistory?.fedRate?.error) && <p role="status" style={{ color: GREY, fontSize: '0.75rem' }}>{macroError || 'Some inflation or Fed rate history is unavailable.'}</p>}
        {equityError && <p role="status" style={{ color: GREY, fontSize: '0.75rem' }}>{equityError}</p>}
        {equityReturns && ['sp500', 'nasdaq100'].some(key => equityReturns[key]?.error) && <p role="status" style={{ color: GREY, fontSize: '0.75rem' }}>Some index returns could not be loaded; unavailable values appear as —.</p>}
        {annualError ? <p role="status" style={{ color: GREY, fontSize: '0.8rem' }}>Couldn't load annual history: {annualError}</p>
          : !annualData ? <p role="status" style={{ color: GREY, fontSize: '0.8rem' }}>Loading annual history…</p>
          : <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums' }}>
              <thead><tr>{['Year', 'Observation date', 'Yield', 'Prior-year yield', 'YoY change (bps)', 'S&P 500 return (%)', 'Nasdaq 100 return (%)', 'CPI inflation YoY (%)', 'Fed effective rate (%)'].map((label, i) =>
                <th key={label} scope="col" style={{ textAlign: i < 2 ? 'left' : 'right', padding: '0.6rem', color: GREY, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{label}</th>
              )}</tr></thead>
              <tbody>{annualRows.map(row => <Fragment key={row.year}><tr onClick={() => toggleYear(row.year)} style={{ cursor: 'pointer', background: expandedYear === row.year ? 'rgba(56,189,248,0.08)' : undefined }}>
                <th scope="row" style={{ textAlign: 'left', padding: '0.6rem', borderBottom: '1px solid var(--border)' }}><button type="button" aria-expanded={expandedYear === row.year} aria-controls={`treasury-months-${row.year}`} onClick={event => { event.stopPropagation(); toggleYear(row.year) }} style={{ background: 'transparent', border: 0, color: 'inherit', font: 'inherit', fontWeight: 700, padding: 0, cursor: 'pointer', whiteSpace: 'nowrap' }}>{expandedYear === row.year ? '▾' : '▸'} {row.year}{row.year === latestYear ? ' (YTD)' : ''}</button></th>
                <td style={{ padding: '0.6rem', color: GREY, borderBottom: '1px solid var(--border)' }}>{new Date(row.year === latestYear ? (annualData.asOf || row.point.t) : row.point.t).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}</td>
                <td style={{ textAlign: 'right', padding: '0.6rem', borderBottom: '1px solid var(--border)' }}>{row.yieldValue.toFixed(2)}%</td>
                <td style={{ textAlign: 'right', padding: '0.6rem', color: GREY, borderBottom: '1px solid var(--border)' }}>{row.previous ? `${row.previous.y.toFixed(2)}%` : '—'}</td>
                <td style={{ textAlign: 'right', padding: '0.6rem', fontWeight: 700, color: row.change == null || row.change === 0 ? GREY : row.change > 0 ? '#f87171' : '#34d399', borderBottom: '1px solid var(--border)' }}>{row.change == null ? '—' : `${row.change > 0 ? '+' : ''}${row.change}`}</td>
                {returnCell('sp500', 'annual', String(row.year))}
                {returnCell('nasdaq100', 'annual', String(row.year))}
                {macroCell('inflation', 'annual', String(row.year))}
                {macroCell('fedRate', 'annual', String(row.year))}
              </tr>
              {expandedYear === row.year && <tr id={`treasury-months-${row.year}`}><td colSpan={9} style={{ padding: '0.8rem 1rem', background: 'rgba(56,189,248,0.04)' }}>
                <h4 style={{ margin: '0 0 0.4rem', fontSize: '0.82rem' }}>{row.year} monthly changes</h4>
                <p style={{ margin: '0 0 0.6rem', color: GREY, fontSize: '0.7rem' }}>Last available weekly observation per month versus the preceding month; January compares with December of the prior year. Current month is month to date. Dates are weekly bar labels, so these are approximate month-end changes.</p>
                <table aria-label={`${row.year} monthly yield changes`} style={{ width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' }}>
                  <thead><tr>{['Month', 'Observation date', 'Yield', 'Prior-month yield', 'Monthly change (bps)', 'S&P 500 return (%)', 'Nasdaq 100 return (%)', 'CPI inflation YoY (%)', 'Fed effective rate (%)'].map((label, i) => <th key={label} scope="col" style={{ padding: '0.5rem', textAlign: i < 2 ? 'left' : 'right', color: GREY, borderBottom: '1px solid var(--border)' }}>{label}</th>)}</tr></thead>
                  <tbody>{monthlyRows.map(month => <tr key={month.key}>
                    <th scope="row" style={{ padding: '0.5rem', textAlign: 'left' }}>{new Date(Date.UTC(row.year, month.month, 1)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })}{month.current ? ' (MTD)' : ''}</th>
                    <td style={{ padding: '0.5rem', color: GREY }}>{new Date(month.current ? annualData.asOf || month.point.t : month.point.t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</td>
                    <td style={{ padding: '0.5rem', textAlign: 'right' }}>{month.value.toFixed(2)}%</td>
                    <td style={{ padding: '0.5rem', textAlign: 'right', color: GREY }}>{month.previous ? `${month.previous.y.toFixed(2)}%` : '—'}</td>
                    <td style={{ padding: '0.5rem', textAlign: 'right', fontWeight: 700, color: month.change == null || month.change === 0 ? GREY : month.change > 0 ? '#f87171' : '#34d399' }}>{month.change == null ? '—' : `${month.change > 0 ? '+' : ''}${month.change}`}</td>
                    {returnCell('sp500', 'monthly', month.key)}
                    {returnCell('nasdaq100', 'monthly', month.key)}
                    {macroCell('inflation', 'monthly', month.key)}
                    {macroCell('fedRate', 'monthly', month.key)}
                  </tr>)}</tbody>
                </table>
              </td></tr>}
              </Fragment>)}</tbody>
            </table>
          </div>}
      </section>
      <EquityDecisionPanel />
      <div style={{ fontSize: '0.66rem', color: GREY, fontStyle: 'italic', marginTop: '0.4rem' }}>
        Rising yields pull money toward bonds and out of emerging-market equities like India · {data?.source || 'Yahoo Finance'}
      </div>
    </div>
  )
}
