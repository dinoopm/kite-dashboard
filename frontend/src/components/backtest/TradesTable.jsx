import { useState, useMemo } from 'react'

const REASON_COLOR = {
  STOP: '#ef4444',
  TARGET: '#22c55e',
  TREND_FLIP: '#fbbf24',
}
const REASON_LABEL = {
  STOP: 'Stop hit',
  TARGET: 'Target hit',
  TREND_FLIP: 'Signal exit',
}

export default function TradesTable({ trades }) {
  const [sort, setSort] = useState({ key: 'entryDate', dir: 'asc' })
  const sorted = useMemo(() => {
    if (!trades) return []
    const arr = [...trades]
    arr.sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key]
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv
      return sort.dir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [trades, sort])

  if (!trades || trades.length === 0) {
    return <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>No closed trades in this period.</p>
  }

  const header = (key, label, align = 'right') => (
    <th
      onClick={() => setSort(s => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}
      style={{ cursor: 'pointer', textAlign: align, fontSize: '0.75rem', whiteSpace: 'nowrap', userSelect: 'none' }}
      title="Click to sort"
    >
      {label}{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  )
  const td = { textAlign: 'right', fontSize: '0.85rem', padding: '0.6rem 1rem', whiteSpace: 'nowrap' }
  const pnlClass = (v) => (v > 0 ? 'positive' : v < 0 ? 'negative' : '')

  return (
    <div className="glass-panel" style={{ padding: '0.5rem 1rem 1rem', overflowX: 'auto' }}>
      <table>
        <thead>
          <tr>
            {header('entryDate', 'Entry', 'left')}
            {header('entryPrice', 'Entry ₹')}
            {header('exitDate', 'Exit', 'left')}
            {header('exitPrice', 'Exit ₹')}
            {header('holdDays', 'Days')}
            {header('rMultiple', 'R')}
            {header('pnlPct', 'P&L %')}
            {header('pnl', 'P&L ₹')}
            {header('exitReason', 'Exit via', 'left')}
          </tr>
        </thead>
        <tbody>
          {sorted.map((t, i) => (
            <tr key={`${t.entryDate}-${i}`}>
              <td style={{ ...td, textAlign: 'left' }}>{t.entryDate}</td>
              <td style={td}>{t.entryPrice.toFixed(1)}</td>
              <td style={{ ...td, textAlign: 'left' }}>{t.exitDate}</td>
              <td style={td}>{t.exitPrice.toFixed(1)}</td>
              <td style={td}>{t.holdDays}</td>
              <td style={td} className={pnlClass(t.rMultiple)}>{t.rMultiple != null ? `${t.rMultiple}R` : '—'}</td>
              <td style={td} className={pnlClass(t.pnlPct)}>{t.pnlPct > 0 ? '+' : ''}{t.pnlPct.toFixed(2)}%</td>
              <td style={td} className={pnlClass(t.pnl)}>{t.pnl > 0 ? '+' : ''}{t.pnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
              <td style={{ ...td, textAlign: 'left', color: REASON_COLOR[t.exitReason] || 'var(--text-secondary)', fontWeight: 600, fontSize: '0.78rem' }}>
                {REASON_LABEL[t.exitReason] || t.exitReason}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
