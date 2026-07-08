import { useState, useEffect } from 'react'

// Per-stock news list for the instrument-page News tab. India: /api/news/:symbol,
// US: /api/us/news/:symbol — both return { items: [{ title, link, source,
// summary, publishedAt }] } from Yahoo (backend/yahooNews.js). Headlines link
// out to the source; the tab degrades to a quiet "no recent news" line for
// thinly-covered tickers rather than erroring.
const GREY = 'var(--text-secondary)'

// "3h ago" / "2d ago" — compact relative time for a news list.
function ago(iso) {
  if (!iso) return null
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000)
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

export default function NewsPanel({ url }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let on = true
    setData(null); setError(null)
    fetch(url)
      .then(r => r.json())
      .then(j => { if (!on) return; j.error ? setError(j.error) : setData(j) })
      .catch(e => on && setError(e.message))
    return () => { on = false }
  }, [url])

  if (error) return <div className="glass-panel" style={{ padding: '1.5rem', color: 'var(--danger)' }}>Couldn't load news: {error}</div>
  if (!data) return <div className="loader" />
  if (!data.items?.length) {
    return (
      <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center', color: GREY }}>
        No recent news for this stock on Yahoo. Coverage of some names — especially smaller Indian tickers — is sparse.
      </div>
    )
  }

  return (
    <div className="glass-panel" style={{ padding: '0.4rem 0 0.5rem' }}>
      {data.items.map((n, i) => (
        <a key={i} href={n.link} target="_blank" rel="noreferrer"
          style={{ display: 'block', textDecoration: 'none', padding: '0.75rem 1.1rem', borderBottom: i < data.items.length - 1 ? '1px solid var(--border)' : 'none' }}>
          <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.4 }}>{n.title}</div>
          {n.summary && <div style={{ fontSize: '0.78rem', color: GREY, lineHeight: 1.5, marginTop: '0.25rem' }}>{n.summary}</div>}
          <div style={{ fontSize: '0.7rem', color: GREY, marginTop: '0.3rem' }}>
            {n.source || 'Yahoo'}{n.publishedAt ? ` · ${ago(n.publishedAt)}` : ''} <span style={{ color: 'var(--accent)' }}>↗</span>
          </div>
        </a>
      ))}
      <div style={{ fontSize: '0.66rem', color: GREY, fontStyle: 'italic', padding: '0.6rem 1.1rem 0.2rem' }}>
        Headlines via Yahoo Finance — links open the original source.
      </div>
    </div>
  )
}
