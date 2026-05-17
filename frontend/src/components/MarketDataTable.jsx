import { useEffect, useMemo, useState } from 'react'

// ─── Formatters ──────────────────────────────────────────────────
function fmtNumber(v) {
  if (v == null || Number.isNaN(v)) return '—'
  return Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })
}
function fmtCr(v, withSign = false) {
  if (v == null || Number.isNaN(v)) return '—'
  const abs = Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })
  if (!withSign) return `₹${abs} Cr`
  return v > 0 ? `+₹${abs} Cr` : v < 0 ? `−₹${abs} Cr` : `₹0 Cr`
}
function fmtCurrency(v) {
  if (v == null || Number.isNaN(v)) return '—'
  return `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
}
function fmtPercent(v, withSign = true) {
  if (v == null || Number.isNaN(v)) return '—'
  const abs = Math.abs(v).toFixed(2)
  if (!withSign) return `${abs}%`
  return v > 0 ? `+${abs}%` : v < 0 ? `−${abs}%` : `0.00%`
}
function fmtDate(v) {
  return v || '—'
}

function formatCell(value, fmt) {
  if (typeof fmt === 'function') return fmt(value)
  switch (fmt) {
    case 'number':          return fmtNumber(value)
    case 'currency':        return fmtCurrency(value)
    case 'cr':              return fmtCr(value)
    case 'signed-cr':       return fmtCr(value, true)
    case 'percent':         return fmtPercent(value)
    case 'date':            return fmtDate(value)
    default:                return value != null ? String(value) : '—'
  }
}

function signedColor(v) {
  if (v == null || v === 0) return 'var(--text-secondary)'
  return v > 0 ? '#10b981' : '#ef4444'
}

// Resolve cell colour from column spec. `color` can be a fixed string or
// a function (value, row) => color.
function resolveColor(col, value, row) {
  if (typeof col.color === 'function') return col.color(value, row)
  if (col.color) return col.color
  if (col.fmt === 'signed-cr' || col.fmt === 'percent') return signedColor(value)
  return col.align === 'right' ? '#cbd5e1' : 'var(--text-primary)'
}

// ─── Date-range presets ──────────────────────────────────────────
function isoToday(offsetDays = 0) {
  const d = new Date()
  d.setDate(d.getDate() - offsetDays)
  return d.toISOString().slice(0, 10)
}
const PRESETS = [
  { key: '7d',   label: 'Last 7 days',  range: () => ({ from: isoToday(7),   to: isoToday(0) }) },
  { key: '30d',  label: 'Last 30 days', range: () => ({ from: isoToday(30),  to: isoToday(0) }) },
  { key: '90d',  label: 'Last 90 days', range: () => ({ from: isoToday(90),  to: isoToday(0) }) },
  { key: '180d', label: 'Last 6 mo',    range: () => ({ from: isoToday(180), to: isoToday(0) }) },
  { key: '1y',   label: 'Last 1 yr',    range: () => ({ from: isoToday(365), to: isoToday(0) }) },
  { key: 'ytd',  label: 'YTD',          range: () => ({ from: `${new Date().getFullYear()}-01-01`, to: isoToday(0) }) },
  { key: 'all',  label: 'All',          range: () => ({ from: '', to: '' }) },
]

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 250]

/**
 * Generic data table for Supabase-backed market data pages.
 *
 * Props:
 *   title           — page heading
 *   description     — subtitle paragraph
 *   endpoint        — API path (e.g. /api/fiidii)
 *   columns         — [{ key, label, align?, fmt?, color?, sortable? }]
 *   dateField       — date column for from/to filtering (null disables date UI)
 *   searchableFields — array of column keys; if non-empty, search input appears
 *                      and is sent as ?search=<q> to the backend
 *   filterFields    — [{ key, label, queryParam, options: [{value, label}] }]
 *                     Segment-style filter chips that map to query params.
 *   defaultPreset   — initial date preset key ('30d', '90d', ...). Default '90d'.
 *   defaultPageSize — default rows per page (default 25)
 *   exportFilename  — (filterState) => string. Default uses endpoint + date range.
 *   aggregations    — optional [{ key, label, fmt, color? }] for the range-total
 *                     footer row. If null, no footer row is rendered.
 *   rowKey          — (row, idx) => string. Default uses idx.
 *   initialSort     — { key, dir } — default sort column and direction
 */
function MarketDataTable({
  title,
  description,
  endpoint,
  columns,
  dateField = 'trade_date',
  searchableFields = [],
  filterFields = [],
  defaultPreset = '90d',
  defaultPageSize = 25,
  exportFilename,
  aggregations = null,
  rowKey,
  initialSort,
}) {
  const useDateFilter = !!dateField
  const initialPreset = useDateFilter ? (PRESETS.find(p => p.key === defaultPreset) || PRESETS[2]) : null
  const initial = useDateFilter ? initialPreset.range() : { from: '', to: '' }

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [from, setFrom] = useState(initial.from)
  const [to, setTo]     = useState(initial.to)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(defaultPageSize)
  const [sort, setSort] = useState(initialSort || (dateField ? { key: dateField, dir: 'desc' } : null))
  const [search, setSearch] = useState('')
  // Active value for each filterField, keyed by filterField.key.
  const [filterState, setFilterState] = useState(() => {
    const init = {}
    for (const f of filterFields) init[f.key] = f.options?.[0]?.value ?? ''
    return init
  })

  // Build query string from filterState + date + search.
  const queryString = useMemo(() => {
    const qs = new URLSearchParams({ limit: '1000' })
    if (useDateFilter && from) qs.set('from', from)
    if (useDateFilter && to)   qs.set('to', to)
    if (search)                qs.set('search', search)
    for (const f of filterFields) {
      const v = filterState[f.key]
      if (v) qs.set(f.queryParam || f.key, v)
    }
    return qs.toString()
  }, [from, to, search, filterState, filterFields, useDateFilter])

  // Debounce so a typing user doesn't fire one request per keystroke.
  useEffect(() => {
    setLoading(true)
    setError(null)
    const handle = setTimeout(() => {
      fetch(`${endpoint}?${queryString}`)
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
    }, 250)
    return () => clearTimeout(handle)
  }, [endpoint, queryString])

  const sorted = useMemo(() => {
    if (!sort) return rows
    const copy = [...rows]
    copy.sort((a, b) => {
      const vA = a?.[sort.key]
      const vB = b?.[sort.key]
      if (vA == null && vB == null) return 0
      if (vA == null) return 1
      if (vB == null) return -1
      const cmp = typeof vA === 'number' && typeof vB === 'number'
        ? vA - vB
        : String(vA).localeCompare(String(vB))
      return sort.dir === 'desc' ? -cmp : cmp
    })
    return copy
  }, [rows, sort])

  const totals = useMemo(() => {
    if (!aggregations) return null
    const acc = {}
    for (const a of aggregations) acc[a.key] = 0
    for (const r of sorted) for (const a of aggregations) acc[a.key] += (r[a.key] || 0)
    return acc
  }, [sorted, aggregations])

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const pageRows = sorted.slice((page - 1) * pageSize, page * pageSize)

  const applyPreset = (preset) => {
    const { from: f, to: t } = preset.range()
    setFrom(f); setTo(t)
  }

  const flipSort = (key) => {
    if (!sort || sort.key !== key) setSort({ key, dir: 'desc' })
    else setSort({ key, dir: sort.dir === 'desc' ? 'asc' : 'desc' })
  }

  const exportCsv = () => {
    const headers = columns.map(c => c.key)
    const lines = [columns.map(c => c.label).join(',')]
    for (const r of sorted) {
      lines.push(headers.map(h => {
        const v = r[h]
        if (v == null) return ''
        const s = String(v).replace(/"/g, '""')
        return /[,"\n]/.test(s) ? `"${s}"` : s
      }).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const fname = typeof exportFilename === 'function'
      ? exportFilename({ from, to, search, filterState })
      : `${endpoint.replace(/^\/api\//, '').replace(/\//g, '_')}_${from || 'all'}_to_${to || 'now'}.csv`
    a.download = fname
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="dashboard-layout" style={{ maxWidth: '1500px', margin: '0 auto', padding: '1rem 2rem' }}>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem', color: 'var(--text-primary)' }}>{title}</h1>
        {description && (
          <p style={{ margin: '0.3rem 0 0 0', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{description}</p>
        )}
      </header>

      <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem', display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
        {useDateFilter && (
          <>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Range</span>
            {PRESETS.map(p => (
              <button
                key={p.key}
                onClick={() => applyPreset(p)}
                style={{
                  padding: '0.35rem 0.7rem', borderRadius: '4px',
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text-secondary)', cursor: 'pointer',
                  fontSize: '0.75rem', fontWeight: 600,
                }}
              >
                {p.label}
              </button>
            ))}
            <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              From
              <input
                type="date" value={from} onChange={e => setFrom(e.target.value)}
                style={{ background: 'var(--bg-dark)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: '4px', padding: '0.3rem 0.5rem', fontSize: '0.8rem' }}
              />
            </label>
            <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              To
              <input
                type="date" value={to} onChange={e => setTo(e.target.value)}
                style={{ background: 'var(--bg-dark)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: '4px', padding: '0.3rem 0.5rem', fontSize: '0.8rem' }}
              />
            </label>
            <span style={{ width: '1px', height: '22px', background: 'var(--border)' }} />
          </>
        )}

        {filterFields.map(f => (
          <label key={f.key} style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            {f.label}
            <select
              value={filterState[f.key] ?? ''}
              onChange={e => setFilterState(s => ({ ...s, [f.key]: e.target.value }))}
              style={{ background: 'var(--bg-dark)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: '4px', padding: '0.3rem 0.5rem', fontSize: '0.8rem' }}
            >
              {f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        ))}

        {searchableFields.length > 0 && (
          <input
            type="text"
            placeholder={`Search ${searchableFields.join(' / ')}…`}
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ background: 'var(--bg-dark)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: '4px', padding: '0.3rem 0.6rem', fontSize: '0.8rem', minWidth: '200px' }}
          />
        )}

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
          title="Download the current filtered set as a CSV file"
        >
          ⬇ Export CSV ({sorted.length})
        </button>
      </div>

      <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading…</div>
        ) : error ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: '#ef4444' }}>Error: {error}</div>
        ) : sorted.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No data for the selected filters.</div>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'JetBrains Mono', monospace" }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)' }}>
                    {columns.map(c => (
                      <th
                        key={c.key}
                        onClick={c.sortable !== false ? () => flipSort(c.key) : undefined}
                        style={{
                          padding: '0.6rem 0.9rem',
                          textAlign: c.align || 'left',
                          color: 'var(--text-secondary)',
                          fontSize: '0.65rem',
                          letterSpacing: '0.5px',
                          cursor: c.sortable === false ? 'default' : 'pointer',
                          userSelect: 'none',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {c.label}{sort?.key === c.key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r, idx) => (
                    <tr key={rowKey ? rowKey(r, idx) : idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                      {columns.map(c => {
                        const value = r[c.key]
                        return (
                          <td
                            key={c.key}
                            style={{
                              padding: '0.55rem 0.9rem',
                              textAlign: c.align || 'left',
                              color: resolveColor(c, value, r),
                              fontSize: '0.78rem',
                              fontWeight: c.bold ? 700 : 500,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {formatCell(value, c.fmt)}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
                {aggregations && totals && (
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--border)', background: 'rgba(255,255,255,0.03)' }}>
                      {columns.map((c, ci) => {
                        const agg = aggregations.find(a => a.key === c.key)
                        if (ci === 0) {
                          return (
                            <td key={c.key} style={{ padding: '0.7rem 0.9rem', color: 'var(--text-secondary)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>
                              Range total ({sorted.length})
                            </td>
                          )
                        }
                        if (!agg) return <td key={c.key} />
                        const v = totals[c.key]
                        return (
                          <td
                            key={c.key}
                            style={{ padding: '0.7rem 0.9rem', textAlign: c.align || 'left', color: resolveColor(agg, v, totals), fontSize: '0.82rem', fontWeight: 800 }}
                          >
                            {formatCell(v, agg.fmt || c.fmt)}
                          </td>
                        )
                      })}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

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
                >‹ Prev</button>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', padding: '0 0.5rem' }}>
                  Page {page} / {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  style={{ padding: '0.3rem 0.7rem', borderRadius: '4px', border: '1px solid var(--border)', background: 'transparent', color: page === totalPages ? 'var(--text-secondary)' : 'var(--text-primary)', cursor: page === totalPages ? 'not-allowed' : 'pointer', fontSize: '0.75rem', opacity: page === totalPages ? 0.4 : 1 }}
                >Next ›</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default MarketDataTable
