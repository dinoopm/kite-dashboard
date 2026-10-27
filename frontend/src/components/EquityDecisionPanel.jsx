import { useEffect, useState } from 'react'
import { equityDecision } from '../lib/equityDecision'
import './EquityDecisionPanel.css'

const date = value => value ? new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—'
const signed = (value, digits = 2) => `${value > 0 ? '+' : ''}${value.toFixed(digits)}`

export default function EquityDecisionPanel() {
  const [index, setIndex] = useState('sp500')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(); setError('Data providers took too long. Retry the assessment.'); setLoading(false) }, 90000)
    fetch('/api/us/market-conditions', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to Kite to load the decision inputs.' : 'Decision inputs could not be loaded. Retry after the server has updated.')
        const result = await response.json()
        if (!Array.isArray(result.signals)) throw new Error('Decision inputs are unavailable from the server. Retry after the server has updated.')
        return result
      })
      .then(result => { if (!controller.signal.aborted) { setData(result); setError(null); setLoading(false) } })
      .catch(reason => { if (!controller.signal.aborted) { setData(null); setError(reason instanceof SyntaxError ? 'The new decision endpoint is not active yet. Sign in again to load the updated server.' : reason.message); setLoading(false) } })
      .finally(() => clearTimeout(timer))
    return () => { clearTimeout(timer); controller.abort() }
  }, [refresh])
  const decision = equityDecision(error ? [] : data?.signals, index)
  const reload = () => { setLoading(true); setError(null); setData(null); setRefresh(value => value + 1) }
  return <section className="equity-decision" aria-labelledby="equity-decision-title" aria-busy={loading}>
    <div className="equity-decision-heading"><div><h3 id="equity-decision-title">Equity decision support</h3><p>Combine the financing backdrop with the market trend before taking more risk.</p></div><div className="equity-decision-controls"><label>Index <select value={index} onChange={event => setIndex(event.target.value)}><option value="sp500">S&amp;P 500</option><option value="nasdaq100">Nasdaq 100</option></select></label><button onClick={reload} disabled={loading}>{loading ? 'Updating…' : 'Refresh assessment'}</button></div></div>
    {error && <p role="alert" className="equity-decision-error">{error}</p>}
    <div className={`equity-decision-verdict equity-decision-${loading ? 'incomplete' : decision.state}`} aria-live="polite"><span className="equity-decision-label">{loading ? 'Loading current inputs' : decision.title}</span><h4>{loading ? 'Building the assessment…' : decision.action}</h4><p>{loading ? 'Checking credit spreads, real yields, financial conditions and the selected index trend.' : decision.summary}</p></div>
    <p className="equity-decision-caveat">Provisional rule-based assessment. Earnings revisions and market breadth are not included. These rules have not been backtested and do not estimate future returns.</p>
    {!loading && data && <><div className="equity-decision-reasons"><article><h4>Supports taking risk</h4>{decision.supports.length ? <ul>{decision.supports.map(reason => <li key={reason}>{reason}</li>)}</ul> : <p>No supportive readings confirmed.</p>}</article><article><h4>Calls for caution</h4>{decision.cautions.length ? <ul>{decision.cautions.map(reason => <li key={reason}>{reason}</li>)}</ul> : <p>No caution signals among the available readings.</p>}</article></div><div className="equity-decision-evidence"><table><caption>Inputs behind this assessment · {decision.usable} of 4 current</caption><thead><tr><th scope="col">Signal</th><th scope="col">Latest reading</th><th scope="col">3-month change</th><th scope="col">As of</th><th scope="col">Status</th></tr></thead><tbody>{decision.selected.map((signal, i) => <tr key={signal?.id || i}><th scope="row">{signal?.source?.url ? <a href={signal.source.url} target="_blank" rel="noopener noreferrer">{signal.title} ↗</a> : signal?.title || 'Unavailable'}</th><td>{Number.isFinite(signal?.value) ? `${signal.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${signal.unit === 'percent' ? '%' : ''}` : '—'}{Number.isFinite(signal?.distanceFromAveragePct) && <small>{signed(signal.distanceFromAveragePct)}% vs 200-day average</small>}</td><td title={signal?.change3m ? `${date(signal.change3m.fromDate)} to ${date(signal.change3m.toDate)}` : undefined}>{Number.isFinite(signal?.change3m?.value) ? `${signed(signal.change3m.value, signal.change3m.unit === 'bps' ? 0 : 2)}${signal.change3m.unit === 'bps' ? ' bps' : signal.change3m.unit === 'percent' ? '%' : ' index points'}` : '—'}</td><td>{date(signal?.asOf)}</td><td>{signal?.stale ? 'Older data' : signal?.status === 'available' ? 'Current' : 'Incomplete'}</td></tr>)}</tbody></table></div></>}
    <div className="equity-decision-next"><h4>What would change the assessment?</h4><p><strong>Supportive:</strong> the index is above its 200-day average, NFCI is below zero, and neither credit spreads nor real yields rose over three months.</p><p><strong>Defensive:</strong> the index is at or below its 200-day average, alongside widening credit spreads or NFCI at or above zero.</p><p><strong>Caution:</strong> other complete combinations. Missing or older inputs produce an incomplete assessment.</p></div>
    <details><summary>Measurement and decision rules</summary><p>These are transparent comparison rules, not optimized trading thresholds. Small moves can change a classification. The assessment describes current conditions and does not determine a position size or entry price.</p><p>NFCI zero is its historical average. Credit spreads measure the extra yield demanded on high-yield corporate bonds. Real yields use 10-year TIPS. Index trend uses 200 completed daily closes; credit and real-yield changes use approximately three calendar months.</p><p>Review earnings and participation separately before acting. Freshness is checked per input: daily series older than 7 calendar days and weekly NFCI older than 14 days are excluded. This assessment is current; it is not a reconstruction of the selected historical table row.</p></details>
  </section>
}
