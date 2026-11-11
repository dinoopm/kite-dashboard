import { useEffect, useState } from 'react';
import { fetchWithAbort } from '../hooks/useFetchWithAbort';
const COLORS = { 'extreme fear': '#fb7185', fear: '#fb923c', neutral: '#fbbf24', greed: '#86efac', 'extreme greed': '#34d399' };
const title = value => value.replace(/\b\w/g, letter => letter.toUpperCase());
const format = value => value == null ? '—' : Math.round(value);
export default function CnnFearGreedPanel({ onData }) {
  const [data, setData] = useState(null), [error, setError] = useState(null), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const res = await fetchWithAbort('/api/us/fear-greed', { signal: controller.signal, timeoutMs: 20_000 });
        if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) throw Error('CNN Fear & Greed could not be loaded.');
        const result = await res.json();
        if (!controller.signal.aborted) { setData(result); setError(null); onData?.(result); }
      } catch (e) { if (!controller.signal.aborted) setError(e.message); }
    }
    load(); const timer = setInterval(load, 5 * 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [attempt, onData]);
  const heading = <div className="us-vix-chart-heading"><h2>CNN Fear &amp; Greed Index</h2><a href="https://www.cnn.com/markets/fear-and-greed" target="_blank" rel="noreferrer">View on CNN ↗</a></div>;
  const reading = data && <>
    {/* A stale reading is greyed and dated in the headline itself. On
        2026-11-03 this panel led with a coloured "27 Fear" from Oct 26 —
        the feed had been refused for a week — and the only hint was a line
        of small amber text underneath. */}
    <div className="cnn-summary"><div><strong style={{ color: data.stale ? 'var(--text-secondary)' : COLORS[data.rating] }}>{format(data.score)}<small> / 100</small></strong><span style={{ color: data.stale ? 'var(--text-secondary)' : COLORS[data.rating] }}>{title(data.rating)}</span></div><div>{data.stale && <span className="cnn-stale-badge">{data.ageDays} {data.ageDays === 1 ? 'day' : 'days'} old — not today's reading</span>}<span className="cnn-source-mode">{data.mode === 'saved' ? 'Saved CNN reading' : 'Latest CNN feed reading'}</span><p>Updated {new Date(data.asOf).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' })} ET</p></div></div>
    <div className={`cnn-meter${data.stale ? ' cnn-meter-stale' : ''}`} role="meter" aria-label="CNN Fear and Greed score" aria-valuemin={0} aria-valuemax={100} aria-valuenow={data.score} aria-valuetext={`${format(data.score)} out of 100, ${data.rating}`}><span style={{ left: `clamp(1px, ${data.score}%, calc(100% - 3px))` }}/></div>
    <div className="cnn-meter-labels">{Object.keys(COLORS).map(label => <span key={label}>{title(label)}</span>)}</div>
    {data.stale && <p className="us-vix-source" style={{ marginTop: 0 }}>The comparisons below are CNN's, relative to that {new Date(data.asOf).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })} reading — not to today.</p>}
    <div className="cnn-comparisons">{[['Previous close', 'previousClose'], ['1 week ago', 'oneWeekAgo'], ['1 month ago', 'oneMonthAgo'], ['1 year ago', 'oneYearAgo']].map(([label, key]) => <div key={key}><span>{label}</span><strong>{format(data[key])}</strong></div>)}</div>
    {data.notice && <p className="cnn-saved-notice">{data.notice}</p>}
    <p className="us-vix-source">CNN combines seven market measures into its own sentiment index. This is independent of the VIX level and the severity rules below. Sentiment alone does not specify a buy or sell trade.</p>
  </>;

  // Collapsed, not deleted, once the reading is stale. From this location CNN
  // refuses the feed (418) and blocks the page outright (451 — "Content
  // Unavailable For Legal Reasons"), so the saved reading can only age; a
  // full gauge in the page's second slot drew the eye to a number from last
  // week. The last reading stays one click away, and the freshness strip at
  // the top of the page still reports it.
  if (data?.stale) {
    const day = new Date(data.asOf).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
    return <section className="glass-panel cnn-fear-greed cnn-collapsed" aria-label="CNN Fear and Greed Index">
      <details>
        <summary><strong>CNN Fear &amp; Greed</strong> — hidden: the latest reading available is {data.ageDays} {data.ageDays === 1 ? 'day' : 'days'} old ({day}){data.mode === 'saved' ? ", because CNN's feed is unavailable from this location" : ''}. Show the last reading</summary>
        <div className="cnn-collapsed-body">{heading}{reading}</div>
      </details>
    </section>;
  }

  return <section className="glass-panel cnn-fear-greed" aria-label="CNN Fear and Greed Index">
    {heading}
    {!data && !error && <p role="status">Loading CNN market sentiment…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => setAttempt(v => v + 1)}>Retry</button></p>}
    {reading}
  </section>;
}
