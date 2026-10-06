import { useEffect, useRef, useState } from 'react'
import { fetchWithAbort } from '../../hooks/useFetchWithAbort'
import './AlertTrackRecord.css'

const pct = value => value == null ? 'Unavailable' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`

export default function AlertTrackRecord({ recording, ruleVersion }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [horizon, setHorizon] = useState('10d')
  const controller = useRef(null)
  useEffect(() => () => controller.current?.abort(), [])

  async function load() {
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    setLoading(true)
    setError(null)
    try {
      const response = await fetchWithAbort('/api/alerts/track-record', { signal: request.signal })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Could not load signal outcomes')
      if (!request.signal.aborted) setData(body)
    } catch (failure) {
      if (!request.signal.aborted) setError(failure.message)
    } finally {
      if (!request.signal.aborted) setLoading(false)
    }
  }

  return (
    <div className="glass-panel alert-audit" style={{ padding: '0.85rem', marginBottom: '1rem', fontSize: '0.75rem' }}>
      <div style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
        Scores are heuristic points out of 100, not calibrated probabilities.
      </div>
      {(recording?.status === 'failed' || recording?.status === 'unavailable') && (
        <p role="status" style={{ color: '#f59e0b' }}>{recording.message}</p>
      )}
      <details onToggle={event => { if (event.currentTarget.open && !data && !loading && !error) load() }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Recorded signal outcomes</summary>
        <p>First observation per action, symbol, day and rule version. Current rule: <code>{data?.currentRuleVersion || ruleVersion || 'Unavailable'}</code>.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', marginBottom: '0.75rem' }}>
          <label>Horizon{' '}
            <select value={horizon} onChange={event => setHorizon(event.target.value)}>
              <option value="5d">5 sessions</option>
              <option value="10d">10 sessions</option>
              <option value="22d">22 sessions</option>
            </select>
          </label>
          <button type="button" disabled={loading} onClick={load}>{loading ? 'Loading…' : error ? 'Retry' : 'Refresh measurements'}</button>
        </div>
        {error && <p role="alert" style={{ color: '#f59e0b' }}>{error}</p>}
        {data && (
          <>
            <p>Hypothetical long holding from the observed quote to the horizon close. Costs: {data.params.costModel.feeBpsPerSide} bps fees + {data.params.costModel.slippageBpsPerSide} bps slippage per side, illustrative. Adverse moves use later session lows.</p>
            {data.groups.length === 0 ? <p>No observations recorded yet. Evidence starts with the first saved observation.</p> : (
              <div className="alert-audit-table" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', minWidth: '740px', textAlign: 'left' }}>
                  <thead><tr>
                    <th>Action / rules</th><th>Score band /100</th><th>Resolved / unresolved</th>
                    <th>Median gross</th><th>Median after costs</th><th>Median adverse</th><th>Net gain / loss / flat</th>
                  </tr></thead>
                  <tbody>{data.groups.map(group => {
                    const result = group.horizons.find(row => row.horizon === horizon)
                    return (
                      <tr key={`${group.ruleVersion}:${group.action}:${group.scoreBand}:${group.exchange}`}>
                        <td style={{ padding: '0.6rem 0.2rem' }}>{group.exchange} · {group.action}<br /><small title={group.ruleVersion}>{group.currentRules ? 'Current rules' : 'Older rules'} · {group.ruleVersion}</small></td>
                        <td>{group.scoreBand}</td>
                        <td>{result.n} / {result.unresolved}{result.underSampled && <><br /><small>Too few to judge (&lt;{data.params.minSample})</small></>}</td>
                        <td>{pct(result.medianGrossPct)}</td>
                        <td>{pct(result.medianNetPct)}</td>
                        <td>{pct(result.medianMaxAdversePct)}<br /><small>{result.nAdverse} measured · {result.adverseUnresolved} missing paths</small></td>
                        <td>{result.outcomesAfterCosts.gains} / {result.outcomesAfterCosts.losses} / {result.outcomesAfterCosts.flat}</td>
                      </tr>
                    )
                  })}</tbody>
                </table>
              </div>
            )}
            <div className="alert-audit-cards">{data.groups.map(group => {
              const result = group.horizons.find(row => row.horizon === horizon)
              return (
                <div className="alert-audit-card" key={`${group.ruleVersion}:${group.action}:${group.scoreBand}:${group.exchange}`}>
                  <strong>{group.exchange} · {group.action} · {group.scoreBand}/100</strong>
                  <p><code>{group.ruleVersion}</code> · {group.currentRules ? 'Current rules' : 'Older rules'}</p>
                  <p>{result.n} resolved / {result.unresolved} unresolved{result.underSampled ? ` · Too few to judge (<${data.params.minSample})` : ''}</p>
                  <dl>
                    <div><dt>Median gross</dt><dd>{pct(result.medianGrossPct)}</dd></div>
                    <div><dt>Median after costs</dt><dd>{pct(result.medianNetPct)}</dd></div>
                    <div><dt>Median adverse</dt><dd>{pct(result.medianMaxAdversePct)}</dd></div>
                    <div><dt>Net gain / loss / flat</dt><dd>{result.outcomesAfterCosts.gains} / {result.outcomesAfterCosts.losses} / {result.outcomesAfterCosts.flat}</dd></div>
                  </dl>
                  <small>Adverse: {result.nAdverse} paths measured / {result.adverseUnresolved} missing</small>
                </div>
              )
            })}</div>
            {data.recentObservations.length > 0 && (
              <details style={{ marginTop: '1rem' }}>
                <summary>Recent input snapshots and individual outcomes</summary>
                {data.recentObservations.map(observation => (
                  <details key={`${observation.symbol}:${observation.ruleVersion}:${observation.action}:${observation.observedAt}`} style={{ marginTop: '0.5rem' }}>
                    <summary>{observation.exchange}:{observation.symbol} · {observation.action} · {observation.score}/100 · {new Date(observation.observedAt).toLocaleString()}</summary>
                    <p>Rule {observation.ruleVersion}. Candles through {observation.candleAsOf || 'unavailable'}. Entry ₹{observation.entryPrice}. Inputs {observation.inputsRecorded ? 'recorded' : 'unavailable'}.</p>
                    <pre style={{ maxWidth: '100%', overflowX: 'auto', fontSize: '0.65rem' }}>{JSON.stringify({ inputs: observation.inputs, outcomes: observation.outcomes }, null, 2)}</pre>
                  </details>
                ))}
              </details>
            )}
            <small>Measurements computed at {new Date(data.generatedAt).toLocaleString()}.</small>
            <details style={{ marginTop: '0.75rem' }}>
              <summary>Measurement assumptions and limitations</summary>
              <ul>{data.caveats.map(caveat => <li key={caveat}>{caveat}</li>)}</ul>
            </details>
          </>
        )}
      </details>
    </div>
  )
}
