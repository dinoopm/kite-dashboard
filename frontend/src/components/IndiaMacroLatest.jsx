import { useEffect, useRef, useState } from 'react'
import { fetchWithAbort, useFetchWithAbort } from '../hooks/useFetchWithAbort'
import { fmtDate } from '../lib/formatDate'
import './IndiaMacroLatest.css'

const STATUS = { actual: 'Actual', provisional: 'Provisional actual', estimate: 'Estimate', projection: 'Projection', budget: 'Budget estimate' }
const ORDER = ['repo', 'cpi', 'gdp', 'fiscal', 'currentAccount', 'forex']
function formatValue(o) {
  if (!o || !Number.isFinite(o.value)) return '—'
  if (o.unit === 'INR crore') return `₹${o.value.toLocaleString('en-IN', { maximumFractionDigits: 0 })} crore`
  if (o.unit === 'USD billion') return `$${o.value.toFixed(2)}B`
  return `${o.value.toFixed(2)}%`
}
function time(value) {
  if (!value) return 'Not yet checked'
  return new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
}
function ReleaseCard({ metric }) {
  const o = metric?.latest
  return (
    <article className="glass-panel india-macro-card" aria-label={metric.label}>
      <div className="india-macro-card-title"><span>{metric.label}</span><span className={`india-macro-status ${metric.availability}`}>{metric.availability === 'available' ? 'Available' : metric.availability === 'stale' ? 'Needs update' : 'Unavailable'}</span></div>
      <strong className="india-macro-value">{formatValue(o)}</strong>
      {o ? <>
        <p className="india-macro-period">{fmtDate(o.referencePeriod)}</p>
        <p>{STATUS[o.status] || o.status} · {o.unit}{o.baseYear ? ` · Base ${o.baseYear}` : ''}</p>
        {o.percentOfBudget != null && <p>{o.percentOfBudget.toFixed(1)}% of the full-year budget estimate</p>}
        {o.stance && <p>Stance: {o.stance}</p>}
        {o.effectiveDate && <p>Latest recorded MPC decision: {fmtDate(o.effectiveDate)}</p>}
        <p>{o.releaseDate ? `Released ${fmtDate(o.releaseDate)}` : 'Release date unavailable from source'}</p>
        <p>First seen: {time(o.firstSeenAt)}</p>
        <a href={o.sourceUrl} target="_blank" rel="noreferrer">{o.source} ↗</a>
      </> : <p>No validated official release is stored yet.</p>}
      <p>Last checked: {time(metric.lastCheckedAt)}</p>
      {metric.error && <p className="india-macro-warning" role="status">Update failed: {metric.error}. {o ? 'Retaining the last successful release.' : 'Retry the source check.'}</p>}
      {metric.error && metric.lastSuccessfulCheckAt && <p>Last successful check: {time(metric.lastSuccessfulCheckAt)}</p>}
      {metric.overdue && <p className="india-macro-warning">Reference period is older than the expected publication window.</p>}
      {metric.checkOverdue && <p className="india-macro-warning">A successful source check is due.</p>}
      {metric.storageWarning && <p className="india-macro-warning">{metric.storageWarning}</p>}
      {o?.historyIncomplete && <p className="india-macro-warning">MPC decision history is incomplete. {o.historyError || ''}</p>}
      {o && <details><summary>Notes and revisions{metric.revisionCount ? ` (${metric.revisionCount})` : ''}</summary>
        <p>{o.note}</p>
        <p>First-seen dates describe when this app observed a value. They are separate from publication dates.</p>
        {metric.recentRevisions?.length > 1 && <ul>{metric.recentRevisions.map((r,i) => <li key={`${r.hash}-${i}`}>{formatValue(r)} · {STATUS[r.status]} · first seen {time(r.firstSeenAt)}</li>)}</ul>}
      </details>}
    </article>
  )
}
export default function IndiaMacroLatest({ onData }) {
  const { data, error, loading, refetch } = useFetchWithAbort('/api/india-macro', { parser: async r => {
    const body = await r.json()
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
    return body
  } })
  const [updated, setUpdated] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState(null)
  const controller = useRef(null)
  const releases = updated || data
  useEffect(() => { if (releases?.series) onData?.(releases) }, [releases, onData])
  useEffect(() => () => controller.current?.abort(), [])
  async function refresh() {
    controller.current?.abort()
    const ctl = new AbortController(); controller.current = ctl
    setRefreshing(true); setRefreshError(null)
    try {
      const r = await fetchWithAbort('/api/india-macro/refresh', { method: 'POST', signal: ctl.signal, timeoutMs: 180000 })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
      if (!ctl.signal.aborted) setUpdated(body)
    } catch(e) {
      if (!ctl.signal.aborted) setRefreshError(e.name === 'RateLimitedError' ? `Please retry in ${Math.ceil(e.retryAfter / 1000)} seconds.` : e.message)
    } finally { if (!ctl.signal.aborted) setRefreshing(false) }
  }
  return (
    <section aria-labelledby="india-latest-heading" className="india-macro-latest">
      <div className="india-macro-heading"><h2 id="india-latest-heading">Latest available releases</h2><button type="button" className="btn" disabled={refreshing || loading} onClick={refresh}>{refreshing ? 'Checking official sources…' : 'Check for updates'}</button></div>
      <p className="india-macro-help">Official RBI, MoSPI and CGA data. Each figure has its own reference period; these are published economic releases, not real-time market prices. Sources are checked daily, with retries after failures.</p>
      {loading && !releases && <p role="status">Loading stored releases…</p>}
      {(error || refreshError) && <p className="india-macro-warning" role="alert">{refreshError || error.message} {error && <button type="button" className="btn" onClick={refetch}>Retry loading releases</button>}</p>}
      {refreshing && <p role="status">Current figures remain visible while the source check runs.</p>}
      {releases?.series && <div className="india-macro-cards">{ORDER.map(key => releases.series[key] && <ReleaseCard key={key} metric={releases.series[key]} />)}</div>}
    </section>
  )
}
