import RiskRegimePanel from '../../components/RiskRegimePanel'
import TreasuryChart from '../../components/TreasuryChart'

// US Macro dashboard — the rates/flows backdrop that drives both US equities
// and (via FII flows) Indian markets. Risk-on/off money-flow read + the 10Y
// Treasury yield chart. Reachable from the US nav dropdown.
export default function UsMacro() {
  return (
    <div className="dashboard-layout">
      <div style={{ marginBottom: '1.25rem' }}>
        <h1 style={{ margin: 0 }}>US Macro</h1>
        <p style={{ margin: '0.3rem 0 0', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          Rates &amp; money-flow backdrop — drives US equities and, through FII flows, Indian markets too.
        </p>
      </div>

      <RiskRegimePanel />
      <TreasuryChart />
    </div>
  )
}
