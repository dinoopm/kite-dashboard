import { useEffect, useState } from 'react';
import { fetchWithAbort } from '../hooks/useFetchWithAbort';
import SignalScore from './SignalScore';
import { tierProximity } from '../lib/tierProximity';
const COLOR = { NEUTRAL: '#34d399', CAUTION: '#fbbf24', STRESS: '#fb923c', 'CRASH MODE': '#fb7185', MIXED: '#94a3b8', INCOMPLETE: '#94a3b8' };
const checksView = checks => <ul>{checks.map(check => <li key={check.label} aria-label={`${check.label}: ${check.pass == null ? 'Unavailable' : check.pass ? 'Met' : 'Not met'}`}><span style={{ color: check.pass === true ? '#34d399' : '#94a3b8' }}>{check.pass == null ? '?' : check.pass ? '✓' : '○'}</span><span>{check.label}</span></li>)}</ul>;
const number = (value, suffix = '') => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(2)}${suffix}` : 'Unavailable';
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// The tenure shown beside the verdict comes from the RECORDED log for the
// current rule version. It used to come from the reconstructed timeline
// (daysInCurrentTier), unlabelled, beside a live verdict — the recorded/
// reconstructed pooling CLAUDE.md forbids. An entry with no prior tier marks
// where the log began, not where the tier did, so it reads "since at least".
function recordedChip(data) {
  const rec = data.context?.recorded;
  if (!rec) return null;
  if (rec.error) return <span className="severity-day-count" title={rec.error}>Recorded history unavailable</span>;
  const reconstructed = Number.isInteger(data.daysInCurrentTier) ? ` The reconstructed history counts ${plural(data.daysInCurrentTier, 'session')}; that is backfilled from today's data and is a weaker standard.` : '';
  if (!rec.entries) return <span className="severity-day-count" title={`Nothing has been recorded under rule ${data.ruleVersion} yet.${reconstructed}`}>Not yet recorded under this rule</span>;
  if (rec.tier !== data.state) return <span className="severity-day-count" title={`The last recorded tier is ${rec.tier}; this ${data.state} reading is recorded on the next daily run.${reconstructed}`}>Last recorded: {rec.tier}</span>;
  const title = `${rec.initial ? `The record for this rule began ${String(rec.capturedAt).slice(0, 10)}, already in ${rec.tier} — the tier may have started earlier.` : `Entered ${rec.tier} from ${rec.priorTier}.`}${reconstructed}`;
  return <span className="severity-day-count" title={title}>Recorded in {rec.tier} since {rec.initial ? 'at least ' : ''}{rec.since}{Number.isInteger(rec.sessions) ? ` · ${plural(rec.sessions, 'session')}` : ''}</span>;
}

// What the same rule says with only VIX swapped for the live quote. On
// 2026-11-03 the page showed CAUTION (VIX 19.42 at the Oct 30 close) while the
// quote above it read 21.01 — and CAUTION requires VIX below 20.
function provisionalNote(data, provisional) {
  if (!provisional || !data) return null;
  const label = id => data.flags?.find(f => f.id === id)?.label || id;
  const off = provisional.flagsOff.map(label), on = provisional.flagsOn.map(label);
  if (!provisional.changesTier && !off.length && !on.length) {
    return <p className="us-vix-source">At the live VIX {provisional.vix.toFixed(2)} the tier and flags hold.</p>;
  }
  const cautionCap = data.state === 'CAUTION' && provisional.vix >= data.rules?.vixCautionMax ? ` (CAUTION requires VIX below ${data.rules.vixCautionMax})` : '';
  return <p className="severity-provisional" role="status">
    <strong>At the live VIX {provisional.vix.toFixed(2)}</strong>, the same rule reads{' '}
    <strong style={{ color: COLOR[provisional.state] }}>{provisional.state}</strong>{provisional.changesTier ? cautionCap : ''}
    {off.length > 0 && <>; {off.join(', ')} {off.length === 1 ? 'turns' : 'turn'} off</>}
    {on.length > 0 && <>; {on.join(', ')} {on.length === 1 ? 'turns' : 'turn'} on</>}.
    {' '}Provisional: every other input is still from {provisional.basis}, so this is not recorded and holds only if the close confirms it.
  </p>;
}

export default function UsRiskSeverityPanel({ showQuoteNote = false, onData, provisional = null }) {
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
    {data?.context?.validation && data.context.validation.status !== 'passed' && (() => {
      const v = data.context.validation, rec = data.context.recorded;
      return <p className="severity-validation-note">Why unvalidated: {v.reason}{rec && !rec.error ? ` Recorded under this rule: ${plural(rec.entries, 'entry', 'entries')}, ${plural(rec.transitions, 'transition')}${rec.earlierVersions ? `; entries from ${plural(rec.earlierVersions, 'earlier rule version')} do not carry over` : ''}.` : ''}</p>;
    })()}
    {!data && !error && <p role="status">Checking volatility, stocks versus bonds, drawdown and credit spreads…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => setAttempt(v => v + 1)}>Retry</button></p>}
    {data && (() => { const proximity = tierProximity(data.tiers, data.state); return <>
      <div className="severity-verdict"><strong style={{ color: COLOR[data.state] }}>{data.state}</strong>{data.state === 'CRASH MODE' && <span className="severity-tag">CONFIRMATION</span>}<span>{data.reason}</span>{recordedChip(data)}</div>
      {provisionalNote(data, provisional)}
      {data.flags?.find(flag => flag.id === 'divergence')?.triggered === true && <p className="severity-divergence-watch"><strong>Credit divergence watch</strong> · equities are near their closing high while credit spreads widen. Display emphasis is raised; the base tier stays {data.state}.</p>}
      <p className="us-vix-source">Daily assessment {data.asOf ? `as of ${data.asOf}` : 'awaiting a common observation date'} · all inputs use the same closing date.{(() => {
        const w = data.context?.waitingOn;
        if (!w?.missing?.length) return showQuoteNote && !provisional ? ' The headline VIX quote above can be newer.' : '';
        // Names the blocked session rather than counting: the freshness strip
        // at the top of the page owns the count, measured against today.
        return ` ${w.date} is not assessed yet: waiting on ${w.missing.join(', ')}${w.missing.includes('HY OAS') ? ', which FRED publishes about a session late' : ''}.`;
      })()}</p>
      <div className="severity-inputs">
        <div><span>VIX close</span><strong>{data.metrics.vix?.toFixed(2) ?? 'Unavailable'}</strong></div>
        <div><span>SPY − TLT · {data.rules.rotationSessions} sessions</span><strong>{number(data.metrics.rotation, ' pp')}</strong></div>
        <div><span>SPY vs {data.rules.highSessions}-session closing high</span><strong>{number(data.metrics.drawdown, '%')}</strong></div>
        <div><span>SPY drop within {data.rules.rapidSessions} sessions</span><strong>{number(data.metrics.rapidDrawdown, '%')}</strong></div>
        <div><span>HY OAS change · {data.rules.rotationSessions} sessions</span><strong>{number(data.metrics.creditChange21, ' bps')}</strong></div>
        <div><span>HY OAS change · {data.rules.rapidSessions} sessions</span><strong>{number(data.metrics.creditChange4, ' bps')}</strong></div>
      </div>
      {/* MIXED — no tier complete — is the usual reading, and on those days no
          card is selected. Say where the reading sits instead of leaving the
          row looking as if the selection went missing: the closest tier is
          outlined (never filled) with what it still lacks. */}
      {(() => {
        const near = proximity.filter(t => t.nearest);
        if (!near.length) return null;
        return <p className="severity-nearest">Between tiers — no card is selected because no tier has every check. Closest: {near.map((t, i) => <span key={t.id}>{i > 0 && ' and '}<strong style={{ color: COLOR[t.id] }}>{t.id}</strong>, {t.met} of {t.total} checks met (still lacks: {t.missing.join('; ')})</span>)}. The verdict stays MIXED until a tier has every check.</p>;
      })()}
      <div className="severity-tiers">{data.tiers.map(tier => {
        const emphasized = data.displayEmphasis === tier.id && data.flags?.find(flag => flag.id === 'divergence')?.triggered === true;
        const p = proximity.find(t => t.id === tier.id);
        const selected = data.state === tier.id;
        return <div key={tier.id} aria-current={selected ? 'true' : undefined} data-nearest={p?.nearest ? 'true' : undefined} style={{ borderColor: emphasized ? '#fbbf24' : selected || p?.nearest ? COLOR[tier.id] : 'var(--border)', borderStyle: p?.nearest && !selected ? 'dashed' : undefined, background: emphasized ? '#fbbf2412' : selected ? `${COLOR[tier.id]}12` : 'transparent' }}><h3 style={{ color: COLOR[tier.id] }}>{tier.id}</h3><span className="severity-role" tabIndex={0} title={tier.explanation}>{tier.role || (tier.id === 'CRASH MODE' ? 'Confirmation' : 'Context')} ⓘ</span>{emphasized && <span className="severity-tag">credit divergence</span>}{p?.nearest && <span className="severity-tag severity-tag-nearest" style={{ color: COLOR[tier.id], borderColor: COLOR[tier.id] }}>closest — not the verdict</span>}{p && <span className="severity-checks-met">{p.met} of {p.total} checks met</span>}{checksView(tier.checks)}</div>;
      })}</div>
      {data.context?.tierShares && (() => {
        const t = data.context.tierShares, pct = k => `${(t.shares[k] ?? 0).toFixed(1)}%`;
        return <p className="us-vix-source">Over {t.total} reconstructed sessions ({t.from} → {t.to}) this rule matched no tier on {pct('MIXED')} of them (MIXED) — NEUTRAL {pct('NEUTRAL')}, CAUTION {pct('CAUTION')}, STRESS {pct('STRESS')}, CRASH MODE {pct('CRASH MODE')}. MIXED is the usual reading, not missing data.</p>;
      })()}
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
    </>; })()}
  </section>;
}
