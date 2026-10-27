import MacroDecisionMonitor from '../../components/MacroDecisionMonitor'
import TreasuryChart from '../../components/TreasuryChart'

// US Macro dashboard — the rates/flows backdrop that drives both US equities
// and (via FII flows) Indian markets. Macro monitor and 10Y Treasury history.
// Market risk severity lives on the US VIX page.
export default function UsMacro() {
  return (
    <div className="dashboard-layout">
      <div style={{ marginBottom: '1.25rem' }}>
        <h1 style={{ margin: 0 }}>US Macro</h1>
        <p style={{ margin: '0.3rem 0 0', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          Rates &amp; money-flow backdrop — drives US equities and, through FII flows, Indian markets too.
        </p>
      </div>

      <MacroDecisionMonitor />
      <TreasuryChart />
    </div>
  )
}
