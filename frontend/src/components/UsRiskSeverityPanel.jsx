import { useEffect, useState } from 'react';
import { fetchWithAbort } from '../hooks/useFetchWithAbort';
import SignalScore from './SignalScore';
const COLOR = { NEUTRAL: '#34d399', CAUTION: '#fbbf24', STRESS: '#fb923c', 'CRASH MODE': '#fb7185', MIXED: '#94a3b8', INCOMPLETE: '#94a3b8' };
const checksView = checks => <ul>{checks.map(check => <li key={check.label} aria-label={`${check.label}: ${check.pass == null ? 'Unavailable' : check.pass ? 'Met' : 'Not met'}`}><span style={{ color: check.pass === true ? '#34d399' : '#94a3b8' }}>{check.pass == null ? '?' : check.pass ? '✓' : '○'}</span><span>{check.label}</span></li>)}</ul>;
const number = (value, suffix = '') => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(2)}${suffix}` : 'Unavailable';
export default function UsRiskSeverityPanel({ showQuoteNote = false, onData }) {
  const [data, setData] = useState(null), [error, setError] = useState(null), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const res = await fetchWithAbort('/api/us/risk-severity', { signal: controller.signal, timeoutMs: 90_000 });
        if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) throw Error('Market risk severity could not be loaded.');
        const result = await res.json();
        if (!controller.signal.aborted) { setData(result); setError(null); onData?.(result); }
      } catch (e) { if (!controller.signal.aborted) setError(e.message); }
    }
    load(); const timer = setInterval(load, 5 * 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [attempt, onData]);
  return <section className="glass-panel us-risk-severity" aria-label="Market risk severity">
    <div className="us-vix-chart-heading"><h2>Market risk severity</h2>{data && <SignalScore signal="us_risk_severity" market="US" entry={data.validation}/>}</div>
    {!data && !error && <p role="status">Checking volatility, stocks versus bonds, drawdown and credit spreads…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => setAttempt(v => v + 1)}>Retry</button></p>}
    {data && <>
      <div className="severity-verdict"><strong style={{ color: COLOR[data.state] }}>{data.state}</strong>{data.state === 'CRASH MODE' && <span className="severity-tag">CONFIRMATION</span>}<span>{data.reason}</span>{Number.isInteger(data.daysInCurrentTier) && <span className="severity-day-count">{data.daysInCurrentTier} {data.daysInCurrentTier === 1 ? 'session' : 'sessions'} in this tier</span>}</div>
      {data.flags?.find(flag => flag.id === 'divergence')?.triggered === true && <p className="severity-divergence-watch"><strong>Credit divergence watch</strong> · equities are near their closing high while credit spreads widen. Display emphasis is raised; the base tier stays {data.state}.</p>}
      <p className="us-vix-source">Daily assessment {data.asOf ? `as of ${data.asOf}` : 'awaiting a common observation date'} · all inputs use the same closing date.{showQuoteNote && ' The headline VIX quote above can be newer.'}</p>
      <div className="severity-inputs">
        <div><span>VIX close</span><strong>{data.metrics.vix?.toFixed(2) ?? 'Unavailable'}</strong></div>
        <div><span>SPY − TLT · {data.rules.rotationSessions} sessions</span><strong>{number(data.metrics.rotation, ' pp')}</strong></div>
        <div><span>SPY vs {data.rules.highSessions}-session closing high</span><strong>{number(data.metrics.drawdown, '%')}</strong></div>
        <div><span>SPY drop within {data.rules.rapidSessions} sessions</span><strong>{number(data.metrics.rapidDrawdown, '%')}</strong></div>
        <div><span>HY OAS change · {data.rules.rotationSessions} sessions</span><strong>{number(data.metrics.creditChange21, ' bps')}</strong></div>
        <div><span>HY OAS change · {data.rules.rapidSessions} sessions</span><strong>{number(data.metrics.creditChange4, ' bps')}</strong></div>
      </div>
      <div className="severity-tiers">{data.tiers.map(tier => {
        const emphasized = data.displayEmphasis === tier.id && data.flags?.find(flag => flag.id === 'divergence')?.triggered === true;
        return <div key={tier.id} aria-current={data.state === tier.id ? 'true' : undefined} style={{ borderColor: emphasized ? '#fbbf24' : data.state === tier.id ? COLOR[tier.id] : 'var(--border)', background: emphasized ? '#fbbf2412' : data.state === tier.id ? `${COLOR[tier.id]}12` : 'transparent' }}><h3 style={{ color: COLOR[tier.id] }}>{tier.id}</h3><span className="severity-role" tabIndex={0} title={tier.explanation}>{tier.role || (tier.id === 'CRASH MODE' ? 'Confirmation' : 'Context')} ⓘ</span>{emphasized && <span className="severity-tag">credit divergence</span>}{checksView(tier.checks)}</div>;
      })}</div>
      <div className="severity-flags" aria-label="Credit divergence and cross-check flags">{(data.flags || []).map(flag => <div key={flag.id} className={flag.triggered ? 'severity-flag-active' : ''}>
        <div className="severity-flag-heading"><h3>{flag.label}</h3><span>{flag.triggered == null ? 'Unavailable' : flag.triggered ? 'WATCH' : 'Not triggered'}</span></div>
        <small>{flag.role}</small>{checksView(flag.checks)}
        {data.flagValidation?.[flag.id] && <SignalScore signal={flag.signal} market="US" entry={data.flagValidation[flag.id]} />}
      </div>)}</div>
      <details><summary>Inputs, vintages and rules</summary>
        <p>Each tier requires every listed check. No match is MIXED; missing or overdue inputs are INCOMPLETE. CRASH MODE confirms an ongoing crash and is not an early warning. Credit divergence and cross-check flags add emphasis without changing the base tier.</p>
        <p>All windows and thresholds come from the versioned configuration. SPY/TLT use price returns excluding distributions. The rapid decline is measured from a closing peak within {data.rules.rapidSessions} SPY sessions. Credit publication lags can make the shared observation date older than the latest quote.</p>
        <p>Rotation baseline: {data.inputs.rotationFrom || 'Unavailable'} → {data.asOf || 'Unavailable'}. Rapid window: {data.inputs.rapidFrom || 'Unavailable'} → {data.asOf || 'Unavailable'}. HY OAS level: {Number.isFinite(data.inputs.creditOasBps) ? `${data.inputs.creditOasBps.toFixed(0)} bps` : 'Unavailable'}. A common date more than {data.rules.staleDays} calendar days old is overdue.</p>
        <div className="severity-vintage-table"><table><thead><tr><th>Input</th><th>Observation date</th><th>Data vintage / retrieval</th></tr></thead><tbody>{(data.vintages || []).map(input => <tr key={input.id}><td>{input.label}<small>{input.source}</small></td><td>{input.observationDate || 'Unavailable'}</td><td>{input.vintageDate ? `As-of vintage ${input.vintageDate}` : input.vintage}<small>Retrieved {new Date(input.retrievedAt).toLocaleString()}</small><small>{input.note}</small></td></tr>)}</tbody></table></div>
        <p>CCC uses <a href="https://fred.stlouisfed.org/series/BAMLH0A3HYC" target="_blank" rel="noreferrer">ICE BofA CCC &amp; Lower OAS</a>, compared with <a href="https://fred.stlouisfed.org/series/BAMLH0A0HYM2" target="_blank" rel="noreferrer">broad HY OAS</a>. Optional CCC data never change the closing date or base tier. Rule version: {data.ruleVersion}.</p>
        <p>Tier and flag transitions are recorded forward with input snapshots. Offline validation uses available-at timestamps and an exchange-session calendar. A current-history reconstruction is not a point-in-time backtest. There is no automatic trade.</p>
      </details>
      {data.warnings.map(message => <p className="cnn-saved-notice" key={message}>{message}</p>)}
      {data.recording?.error && <p className="cnn-saved-notice">{data.recording.error}</p>}
    </>}
  </section>;
}
