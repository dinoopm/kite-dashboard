import { useState, useEffect } from 'react'
import { fmtDate } from '../lib/formatDate'

// Institutional-activity header for the India instrument page's Institutional
// tab, rendered above the existing quarterly ShareholdingPanel chart. Fetches
// /api/institutional/:symbol (quarterly trend + 90d bulk/block deals +
// delivery trend + deterministic verdict — backend/picks/institutional.js)
// and /api/fiidii for market-wide context. Each block renders independently,
// mirroring how the backend degrades per source.
const TONES = {
  good: { color: '#34d399', border: 'rgba(52,211,153,0.45)' },
  neutral: { color: 'var(--text-secondary)', border: 'var(--border)' },
  warn: { color: '#fbbf24', border: 'rgba(251,191,36,0.45)' },
}
const GREEN = '#34d399', RED = '#f87171'

const fmtCr = (v) => (v == null ? '—' : `₹${Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-IN') : v} cr`)
const signed = (v, unit = '') => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v}${unit}`)

function Stat({ label, value, color, sub }) {
  return (
    <div style={{ minWidth: '150px' }}>
      <div style={{ fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ fontSize: '1.05rem', fontWeight: 600, color: color || 'var(--text-primary)' }}>{value}</div>
      {sub && <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>{sub}</div>}
    </div>
  )
}

export default function InstitutionalPanel({ symbol }) {
  const [d, setD] = useState(null)
  const [market, setMarket] = useState(null)

  useEffect(() => {
    let on = true
    setD(null); setMarket(null)
    fetch(`/api/institutional/${encodeURIComponent(symbol)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (on) setD(j) })
      .catch(() => { })
    fetch('/api/fiidii?limit=5')
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (on && Array.isArray(j)) setMarket(j) })
      .catch(() => { })
    return () => { on = false }
  }, [symbol])

  if (!d || d.error) return null
  const tone = TONES[d.verdict?.tone] || TONES.neutral
  const deliv = d.delivery
  const delivTrend = deliv ? (deliv.recentAvg > deliv.priorAvg ? 'rising' : deliv.recentAvg < deliv.priorAvg ? 'falling' : 'flat') : null
  const fiiNet5 = market ? +market.reduce((s, r) => s + (r.fii_net || 0), 0).toFixed(0) : null
  const diiNet5 = market ? +market.reduce((s, r) => s + (r.dii_net || 0), 0).toFixed(0) : null

  return (
    <section className="glass-panel" style={{ marginTop: '1rem', padding: '1rem 1.25rem' }}>
      {d.verdict && (
        <div style={{ marginBottom: '0.9rem' }}>
          <span style={{
            fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px',
            color: tone.color, border: `1px solid ${tone.border}`, borderRadius: '4px', padding: '0.1rem 0.4rem', marginRight: '0.7rem',
          }}>{d.verdict.label}</span>
          <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{d.verdict.detail}</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
        <Stat label="FII+DII stake, 2 qtrs" value={signed(d.instChange2Q, ' pp')}
          color={d.instChange2Q == null ? undefined : d.instChange2Q >= 0 ? GREEN : RED} sub="from quarterly filings" />
        <Stat label="Promoters, 2 qtrs" value={signed(d.promoterChange2Q, ' pp')}
          color={d.promoterChange2Q == null ? undefined : d.promoterChange2Q >= 0 ? GREEN : RED} />
        <Stat label="Bulk/block deals, 90d" value={d.deals?.netCr == null ? '—' : `${d.deals.netCr >= 0 ? '+' : '−'}${fmtCr(Math.abs(d.deals.netCr))}`}
          color={d.deals?.netCr == null ? undefined : d.deals.netCr >= 0 ? GREEN : RED}
          sub={d.deals ? `${d.deals.count} deal(s) · ₹${d.deals.buyCr} cr bought / ₹${d.deals.sellCr} cr sold` : 'no disclosed deals'} />
        <Stat label="Delivery %" value={deliv ? `${deliv.priorAvg}% → ${deliv.recentAvg}%` : '—'}
          color={delivTrend === 'rising' ? GREEN : delivTrend === 'falling' ? RED : undefined}
          sub={deliv ? `last 5 vs prior 15 sessions · ${delivTrend}` : null} />
      </div>

      {d.deals?.recent?.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
            Recent bulk/block deals
          </div>
          {d.deals.recent.slice(0, 8).map((dl, i) => (
            <div key={i} style={{ display: 'flex', gap: '0.8rem', padding: '0.35rem 0', borderBottom: '1px solid var(--border)', fontSize: '0.8rem', fontVariantNumeric: 'tabular-nums', alignItems: 'baseline' }}>
              <span style={{ flex: '0 0 5.5rem', color: 'var(--text-secondary)' }}>{fmtDate(dl.date)}</span>
              <span style={{ flex: '0 0 3rem', fontWeight: 700, color: dl.type === 'BUY' ? GREEN : RED }}>{dl.type}</span>
              <span style={{ flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dl.client}</span>
              <span style={{ flex: '0 0 auto', color: 'var(--text-secondary)' }}>{dl.qty?.toLocaleString('en-IN')} @ ₹{dl.price}</span>
              <span style={{ flex: '0 0 5rem', textAlign: 'right', fontWeight: 600 }}>₹{dl.valueCr} cr</span>
            </div>
          ))}
        </div>
      )}

      <p style={{ margin: '0.8rem 0 0', fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
        {fiiNet5 != null && (
          <span>Market context (5 sessions): FII {signed(fiiNet5)} cr, DII {signed(diiNet5)} cr net in cash market · </span>
        )}
        <span style={{ fontStyle: 'italic' }}>{d.source}. Holdings are quarterly disclosures — deals and delivery are the daily footprints between filings.</span>
      </p>
    </section>
  )
}
