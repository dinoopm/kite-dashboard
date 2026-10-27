import { useEffect, useState } from 'react';
import { fetchWithAbort } from '../hooks/useFetchWithAbort';
const COLORS = { 'extreme fear': '#fb7185', fear: '#fb923c', neutral: '#fbbf24', greed: '#86efac', 'extreme greed': '#34d399' };
const title = value => value.replace(/\b\w/g, letter => letter.toUpperCase());
const format = value => value == null ? '—' : Math.round(value);
export default function CnnFearGreedPanel() {
  const [data, setData] = useState(null), [error, setError] = useState(null), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const res = await fetchWithAbort('/api/us/fear-greed', { signal: controller.signal, timeoutMs: 20_000 });
        if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) throw Error('CNN Fear & Greed could not be loaded.');
        const result = await res.json();
        if (!controller.signal.aborted) { setData(result); setError(null); }
      } catch (e) { if (!controller.signal.aborted) setError(e.message); }
    }
    load(); const timer = setInterval(load, 5 * 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [attempt]);
  return <section className="glass-panel cnn-fear-greed" aria-label="CNN Fear and Greed Index">
    <div className="us-vix-chart-heading"><h2>CNN Fear &amp; Greed Index</h2><a href="https://www.cnn.com/markets/fear-and-greed" target="_blank" rel="noreferrer">View on CNN ↗</a></div>
    {!data && !error && <p role="status">Loading CNN market sentiment…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => setAttempt(v => v + 1)}>Retry</button></p>}
    {data && <>
      <div className="cnn-summary"><div><strong style={{ color: COLORS[data.rating] }}>{format(data.score)}<small> / 100</small></strong><span style={{ color: COLORS[data.rating] }}>{title(data.rating)}</span></div><div><span className="cnn-source-mode">{data.mode === 'saved' ? 'Saved CNN reading' : 'Latest CNN feed reading'}</span><p>Updated {new Date(data.asOf).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' })} ET</p></div></div>
      <div className="cnn-meter" role="meter" aria-label="CNN Fear and Greed score" aria-valuemin={0} aria-valuemax={100} aria-valuenow={data.score} aria-valuetext={`${format(data.score)} out of 100, ${data.rating}`}><span style={{ left: `clamp(1px, ${data.score}%, calc(100% - 3px))` }}/></div>
      <div className="cnn-meter-labels">{Object.keys(COLORS).map(label => <span key={label}>{title(label)}</span>)}</div>
      <div className="cnn-comparisons">{[['Previous close', 'previousClose'], ['1 week ago', 'oneWeekAgo'], ['1 month ago', 'oneMonthAgo'], ['1 year ago', 'oneYearAgo']].map(([label, key]) => <div key={key}><span>{label}</span><strong>{format(data[key])}</strong></div>)}</div>
      {data.notice && <p className="cnn-saved-notice">{data.notice}</p>}
      <p className="us-vix-source">CNN combines seven market measures into its own sentiment index. This is independent of the VIX level and the severity rules below. Sentiment alone does not specify a buy or sell trade.</p>
    </>}
  </section>;
}
