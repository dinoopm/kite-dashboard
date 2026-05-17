import { useEffect, useMemo, useState } from 'react'

// Format a number as ₹ Cr with Indian thousand separators (and a sign when needed).
function fmtCr(v, withSign = false) {
  if (v == null || Number.isNaN(v)) return '—'
  const abs = Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })
  if (!withSign) return `₹${abs} Cr`
  if (v > 0) return `+₹${abs} Cr`
  if (v < 0) return `−₹${abs} Cr`
  return `₹0 Cr`
}

// Pick the colour for a net value: green positive, red negative, slate zero.
function netColor(v) {
  if (v == null || v === 0) return 'var(--text-secondary)'
  return v > 0 ? '#10b981' : '#ef4444'
}

function isoToday(offsetDays = 0) {
  const d = new Date()
  d.setDate(d.getDate() - offsetDays)
  return d.toISOString().slice(0, 10)
}

// Preset date-range buttons. Each returns { from, to } in ISO format.
const PRESETS = [
  { key: '30d',  label: 'Last 30 days', range: () => ({ from: isoToday(30),  to: isoToday(0) }) },
  { key: '90d',  label: 'Last 90 days', range: () => ({ from: isoToday(90),  to: isoToday(0) }) },
  { key: '180d', label: 'Last 6 mo',    range: () => ({ from: isoToday(180), to: isoToday(0) }) },
  { key: '1y',   label: 'Last 1 yr',    range: () => ({ from: isoToday(365), to: isoToday(0) }) },
  { key: 'ytd',  label: 'YTD',          range: () => ({ from: `${new Date().getFullYear()}-01-01`, to: isoToday(0) }) },
  { key: 'all',  label: 'All',          range: () => ({ from: '',            to: '' }) },
]

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

function FiiDii() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Default to "Last 90 days" — a reasonable opening view.
  const [from, setFrom] = useState(isoToday(90))
  const [to, setTo] = useState(isoToday(0))
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [sortDir, setSortDir] = useState('desc')

  useEffect(() => {
    setLoading(true)
    setError(null)
    const qs = new URLSearchParams({ limit: '1000' })
    if (from) qs.set('from', from)
    if (to)   qs.set('to', to)
    fetch(`/api/fiidii?${qs.toString()}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(data => {
        setRows(Array.isArray(data) ? data : [])
        setPage(1)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [from, to])

  const sorted = useMemo(() => {
    const copy = [...rows]
    copy.sort((a, b) => {
      const cmp = (a.trade_date || '').localeCompare(b.trade_date || '')
      return sortDir === 'desc' ? -cmp : cmp
    })
    return copy
  }, [rows, sortDir])

  const totals = useMemo(() => {
    return sorted.reduce((acc, r) => ({
      fii_buy:  acc.fii_buy  + (r.fii_buy  || 0),
      fii_sell: acc.fii_sell + (r.fii_sell || 0),
      fii_net:  acc.fii_net  + (r.fii_net  || 0),
      dii_buy:  acc.dii_buy  + (r.dii_buy  || 0),
      dii_sell: acc.dii_sell + (r.dii_sell || 0),
      dii_net:  acc.dii_net  + (r.dii_net  || 0),
    }), { fii_buy: 0, fii_sell: 0, fii_net: 0, dii_buy: 0, dii_sell: 0, dii_net: 0 })
  }, [sorted])

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const pageRows = sorted.slice((page - 1) * pageSize, page * pageSize)

  const applyPreset = (preset) => {
    const { from: f, to: t } = preset.range()
    setFrom(f)
    setTo(t)
  }

  const exportCsv = () => {
    const headers = ['trade_date', 'fii_buy', 'fii_sell', 'fii_net', 'dii_buy', 'dii_sell', 'dii_net']
    const lines = [headers.join(',')]
    for (const r of sorted) {
      lines.push(headers.map(h => r[h] != null ? r[h] : '').join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `fii_dii_${from || 'all'}_to_${to || 'now'}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="dashboard-layout" style={{ maxWidth: '1400px', margin: '0 auto', padding: '1rem 2rem' }}>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem', color: 'var(--text-primary)' }}>FII / DII Activity</h1>
        <p style={{ margin: '0.3rem 0 0 0', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          Daily cash-market flows — Foreign Institutional Investors and Domestic Institutional Investors. Source: NSE archive, daily sync.
        </p>
      </header>

      {/* Controls row */}
      <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem', display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Range</span>
        {PRESETS.map(p => (
          <button
            key={p.key}
            onClick={() => applyPreset(p)}
            style={{
              padding: '0.35rem 0.7rem',
              borderRadius: '4px',
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '0.75rem',
              fontWeight: 600,
            }}
          >
            {p.label}
          </button>
        ))}
        <span style={{ width: '1px', height: '22px', background: 'var(--border)' }} />
        <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          From
          <input
            type="date"
            value={from}
            onChange={e => setFrom(e.target.value)}
            style={{ background: 'var(--bg-dark)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: '4px', padding: '0.3rem 0.5rem', fontSize: '0.8rem' }}
          />
        </label>
        <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          To
          <input
            type="date"
            value={to}
            onChange={e => setTo(e.target.value)}
            style={{ background: 'var(--bg-dark)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: '4px', padding: '0.3rem 0.5rem', fontSize: '0.8rem' }}
          />
        </label>

        <div style={{ flex: 1 }} />

        <button
          onClick={exportCsv}
          disabled={sorted.length === 0}
          style={{
            padding: '0.4rem 0.9rem', borderRadius: '4px',
            border: '1px solid #10b981', background: 'rgba(16,185,129,0.10)',
            color: '#10b981', cursor: sorted.length === 0 ? 'not-allowed' : 'pointer',
            opacity: sorted.length === 0 ? 0.4 : 1,
            fontWeight: 700, fontSize: '0.8rem', letterSpacing: '0.3px'
          }}
          title="Download the current filtered range as a CSV file"
        >
          ⬇ Export CSV ({sorted.length})
        </button>
      </div>

      {/* Table */}
      <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading…</div>
        ) : error ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: '#ef4444' }}>Error: {error}</div>
        ) : sorted.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No data for the selected range.</div>
        ) : (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'JetBrains Mono', monospace" }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)' }}>
                  <th
                    onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}
                    style={{ padding: '0.7rem 1rem', textAlign: 'left', color: 'var(--text-secondary)', fontSize: '0.7rem', letterSpacing: '0.5px', cursor: 'pointer', userSelect: 'none' }}
                  >
                    DATE {sortDir === 'desc' ? '↓' : '↑'}
                  </th>
                  <th colSpan={3} style={{ padding: '0.7rem 1rem', textAlign: 'center', color: '#3b82f6', fontSize: '0.7rem', letterSpacing: '0.5px', borderLeft: '1px solid var(--border)' }}>
                    FII (Foreign)
                  </th>
                  <th colSpan={3} style={{ padding: '0.7rem 1rem', textAlign: 'center', color: '#a855f7', fontSize: '0.7rem', letterSpacing: '0.5px', borderLeft: '1px solid var(--border)' }}>
                    DII (Domestic)
                  </th>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: '0.5rem 1rem' }} />
                  <th style={{ padding: '0.5rem 1rem', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '0.65rem', borderLeft: '1px solid var(--border)' }}>BUY</th>
                  <th style={{ padding: '0.5rem 1rem', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '0.65rem' }}>SELL</th>
                  <th style={{ padding: '0.5rem 1rem', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '0.65rem' }}>NET</th>
                  <th style={{ padding: '0.5rem 1rem', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '0.65rem', borderLeft: '1px solid var(--border)' }}>BUY</th>
                  <th style={{ padding: '0.5rem 1rem', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '0.65rem' }}>SELL</th>
                  <th style={{ padding: '0.5rem 1rem', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '0.65rem' }}>NET</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map(r => (
                  <tr key={r.trade_date} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                    <td style={{ padding: '0.6rem 1rem', color: 'var(--text-primary)', fontSize: '0.8rem', fontWeight: 600 }}>
                      {r.trade_date}
                    </td>
                    <td style={{ padding: '0.6rem 1rem', textAlign: 'right', color: '#cbd5e1', fontSize: '0.8rem', borderLeft: '1px solid var(--border)' }}>{fmtCr(r.fii_buy)}</td>
                    <td style={{ padding: '0.6rem 1rem', textAlign: 'right', color: '#cbd5e1', fontSize: '0.8rem' }}>{fmtCr(r.fii_sell)}</td>
                    <td style={{ padding: '0.6rem 1rem', textAlign: 'right', color: netColor(r.fii_net), fontSize: '0.85rem', fontWeight: 700 }}>{fmtCr(r.fii_net, true)}</td>
                    <td style={{ padding: '0.6rem 1rem', textAlign: 'right', color: '#cbd5e1', fontSize: '0.8rem', borderLeft: '1px solid var(--border)' }}>{fmtCr(r.dii_buy)}</td>
                    <td style={{ padding: '0.6rem 1rem', textAlign: 'right', color: '#cbd5e1', fontSize: '0.8rem' }}>{fmtCr(r.dii_sell)}</td>
                    <td style={{ padding: '0.6rem 1rem', textAlign: 'right', color: netColor(r.dii_net), fontSize: '0.85rem', fontWeight: 700 }}>{fmtCr(r.dii_net, true)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)', background: 'rgba(255,255,255,0.03)' }}>
                  <td style={{ padding: '0.7rem 1rem', color: 'var(--text-secondary)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>
                    Range total ({sorted.length} days)
                  </td>
                  <td style={{ padding: '0.7rem 1rem', textAlign: 'right', color: '#cbd5e1', fontSize: '0.8rem', borderLeft: '1px solid var(--border)' }}>{fmtCr(totals.fii_buy)}</td>
                  <td style={{ padding: '0.7rem 1rem', textAlign: 'right', color: '#cbd5e1', fontSize: '0.8rem' }}>{fmtCr(totals.fii_sell)}</td>
                  <td style={{ padding: '0.7rem 1rem', textAlign: 'right', color: netColor(totals.fii_net), fontSize: '0.85rem', fontWeight: 800 }}>{fmtCr(totals.fii_net, true)}</td>
                  <td style={{ padding: '0.7rem 1rem', textAlign: 'right', color: '#cbd5e1', fontSize: '0.8rem', borderLeft: '1px solid var(--border)' }}>{fmtCr(totals.dii_buy)}</td>
                  <td style={{ padding: '0.7rem 1rem', textAlign: 'right', color: '#cbd5e1', fontSize: '0.8rem' }}>{fmtCr(totals.dii_sell)}</td>
                  <td style={{ padding: '0.7rem 1rem', textAlign: 'right', color: netColor(totals.dii_net), fontSize: '0.85rem', fontWeight: 800 }}>{fmtCr(totals.dii_net, true)}</td>
                </tr>
              </tfoot>
            </table>

            {/* Pagination */}
            <div style={{ padding: '0.75rem 1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border)', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                Showing <strong style={{ color: 'var(--text-primary)' }}>{(page - 1) * pageSize + 1}</strong>–<strong style={{ color: 'var(--text-primary)' }}>{Math.min(page * pageSize, sorted.length)}</strong> of <strong style={{ color: 'var(--text-primary)' }}>{sorted.length}</strong>
              </div>
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  Rows:&nbsp;
                  <select
                    value={pageSize}
                    onChange={e => { setPageSize(parseInt(e.target.value, 10)); setPage(1) }}
                    style={{ background: 'var(--bg-dark)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: '4px', padding: '0.2rem 0.4rem', fontSize: '0.75rem' }}
                  >
                    {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  style={{ padding: '0.3rem 0.7rem', borderRadius: '4px', border: '1px solid var(--border)', background: 'transparent', color: page === 1 ? 'var(--text-secondary)' : 'var(--text-primary)', cursor: page === 1 ? 'not-allowed' : 'pointer', fontSize: '0.75rem', opacity: page === 1 ? 0.4 : 1 }}
                >
                  ‹ Prev
                </button>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', padding: '0 0.5rem' }}>
                  Page {page} / {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  style={{ padding: '0.3rem 0.7rem', borderRadius: '4px', border: '1px solid var(--border)', background: 'transparent', color: page === totalPages ? 'var(--text-secondary)' : 'var(--text-primary)', cursor: page === totalPages ? 'not-allowed' : 'pointer', fontSize: '0.75rem', opacity: page === totalPages ? 0.4 : 1 }}
                >
                  Next ›
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default FiiDii
