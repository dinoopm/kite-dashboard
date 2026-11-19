import { useFetchJson } from '../hooks/useFetchJson'

// "Results on 08 Jul" / "Earnings 21–25 Jul" chip for the instrument pages.
// India: /api/events/:symbol (NSE board-meeting calendar — results, dividend,
// fund raising). US: /api/us/events/:symbol (Yahoo earnings window + ex-div).
// Scheduled events blindside every backward-looking indicator, so this sits
// in the header where it's seen before any verdict is trusted.
const fmt = (iso) => {
  if (!iso) return null
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}
const daysUntil = (iso) => Math.ceil((new Date(iso + 'T00:00:00') - new Date()) / 86400000)

// The chips a response produces, or null for none. Pure.
function chipsFrom(j) {
  if (!j || j.error) return null
  const out = []
  // India shape: { events: [{ purpose, date, detail }] }
  for (const e of (j.events || []).slice(0, 2)) {
    out.push({ label: `${e.purpose} · ${fmt(e.date)}`, date: e.date, title: e.detail })
  }
  // US shape: { earnings: {from,to}, exDividendDate }. Yahoo returns the
  // LAST report when the next one isn't scheduled yet — show only if the
  // window's end is still ahead.
  if (j.earnings && daysUntil(j.earnings.to) >= 0) {
    const win = j.earnings.from === j.earnings.to ? fmt(j.earnings.from) : `${fmt(j.earnings.from)}–${fmt(j.earnings.to)}`
    out.push({ label: `Earnings ${win}`, date: j.earnings.from, title: 'Next earnings (Yahoo; a range until the company confirms)' })
  }
  if (j.exDividendDate && daysUntil(j.exDividendDate) >= 0) {
    out.push({ label: `Ex-div ${fmt(j.exDividendDate)}`, date: j.exDividendDate, title: 'Ex-dividend date' })
  }
  return out.length ? out : null
}

export default function EventBadge({ url }) {
  const { data } = useFetchJson(url)
  const items = chipsFrom(data)

  if (!items) return null
  return (
    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', margin: '0 0 0.9rem' }}>
      {items.map((it, i) => {
        const d = daysUntil(it.date)
        const soon = d != null && d >= 0 && d <= 7
        return (
          <span key={i} title={`${it.title || ''}${d === 0 ? ' · today' : d > 0 ? ` · in ${d} day${d === 1 ? '' : 's'}` : ''}`} style={{
            fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.3px',
            color: soon ? '#fbbf24' : 'var(--text-secondary)',
            border: `1px solid ${soon ? 'rgba(251,191,36,0.45)' : 'var(--border)'}`,
            borderRadius: '4px', padding: '0.15rem 0.45rem',
            animation: d === 0 ? 'eventTodayPulse 1.4s ease-in-out infinite' : undefined,
          }}>📅 {it.label}{d === 0 ? ' · today' : d != null && d > 0 ? ` (${d}d)` : ''}</span>
        )
      })}
    </div>
  )
}
