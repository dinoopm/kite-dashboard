import EquityCurveChart from './EquityCurveChart'
import TradesTable from './TradesTable'
import { fmtDate } from '../../lib/formatDate'

const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`)
const pnlClass = (v) => (v == null ? '' : v > 0 ? 'positive' : v < 0 ? 'negative' : '')

function MetricCard({ label, value, sub, valueClass }) {
  return (
    <div className="glass-panel stat-card" style={{ padding: '0.9rem 1.1rem', minWidth: '140px', flex: 1 }}>
      <span className="label" style={{ fontSize: '0.68rem', marginBottom: '0.25rem' }}>{label}</span>
      <span className={`value ${valueClass || ''}`} style={{ fontSize: '1.35rem' }}>{value}</span>
      {sub && <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>{sub}</span>}
    </div>
  )
}

// Shared results block: metric cards + equity curve (+ trades table for
// single-stock runs; basket runs pass trades={null} and show their own
// per-stock breakdown instead).
export default function BacktestResults({ metrics, equityCurve, buyHoldCurve, trades, openPosition, fromDate, toDate }) {
  if (!metrics) return null
  const m = metrics
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <MetricCard label="Total return" value={fmtPct(m.totalReturnPct)} valueClass={pnlClass(m.totalReturnPct)}
          sub={`Buy & hold ${fmtPct(m.buyHold?.totalReturnPct)}`} />
        <MetricCard label="CAGR" value={fmtPct(m.cagr)} valueClass={pnlClass(m.cagr)}
          sub={`Buy & hold ${fmtPct(m.buyHold?.cagr)}`} />
        <MetricCard label="Win rate" value={m.winRate != null ? `${m.winRate}%` : '—'}
          sub={`${m.wins}W / ${m.losses}L of ${m.totalTrades}`} />
        <MetricCard label="Profit factor" value={m.profitFactor != null ? m.profitFactor : '∞'}
          sub={m.expectancyR != null ? `Expectancy ${m.expectancyR}R` : null} />
        <MetricCard label="Max drawdown" value={fmtPct(m.maxDrawdownPct)} valueClass="negative"
          sub={`Buy & hold ${fmtPct(m.buyHold?.maxDrawdownPct)}`} />
        <MetricCard label="Avg hold" value={m.avgHoldDays != null ? `${m.avgHoldDays}d` : '—'}
          sub={m.exposurePct != null ? `${m.exposurePct}% time in market` : null} />
      </div>

      {(fromDate || toDate) && (
        <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
          Period: {fmtDate(fromDate)} → {fmtDate(toDate)} · fills at next-day open · intrabar stops are pessimistic (stop beats target) · costs split across both legs
        </p>
      )}

      <EquityCurveChart equityCurve={equityCurve} buyHoldCurve={buyHoldCurve} />

      {openPosition && (
        <div className="glass-panel" style={{ padding: '0.8rem 1.1rem', fontSize: '0.85rem', borderLeft: '3px solid var(--accent)' }}>
          <strong style={{ color: 'var(--accent)' }}>Open position at data end:</strong>{' '}
          entered {fmtDate(openPosition.entryDate)} @ ₹{openPosition.entryPrice} ·
          last close ₹{openPosition.lastClose} ·{' '}
          <span className={pnlClass(openPosition.unrealizedPct)}>
            {openPosition.unrealizedPct > 0 ? '+' : ''}{openPosition.unrealizedPct}% unrealized
          </span>{' '}
          · trailing stop ₹{openPosition.stop}. Excluded from closed-trade stats; included in the equity curve.
        </div>
      )}

      {trades !== null && (
        <>
          <h3 style={{ margin: '0.25rem 0 0' }}>Trades ({trades?.length ?? 0})</h3>
          <TradesTable trades={trades} />
        </>
      )}
    </div>
  )
}
