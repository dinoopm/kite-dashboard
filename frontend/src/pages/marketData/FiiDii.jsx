import MarketDataTable from '../../components/MarketDataTable'
import FiiDiiDashboard from './FiiDiiDashboard'

// FII (Foreign Institutional Investors) and DII (Domestic Institutional
// Investors) daily cash-market activity. Source: NSE, daily sync.
// The visual dashboard (flows, derivatives positioning, Nifty correlation)
// sits on top; the full historical table remains below for the raw numbers.
function FiiDii() {
  return (
    <>
    <FiiDiiDashboard />
    <MarketDataTable
      title="FII / DII Activity"
      description="Daily cash-market flows — Foreign Institutional Investors and Domestic Institutional Investors. Source: NSE archive, daily sync."
      endpoint="/api/fiidii"
      dateField="trade_date"
      defaultPreset="90d"
      rowKey={(r) => r.trade_date}
      initialSort={{ key: 'trade_date', dir: 'desc' }}
      columns={[
        { key: 'trade_date', label: 'DATE',        fmt: 'date',      bold: true },
        { key: 'fii_buy',    label: 'FII BUY',     fmt: 'cr',        align: 'right' },
        { key: 'fii_sell',   label: 'FII SELL',    fmt: 'cr',        align: 'right' },
        { key: 'fii_net',    label: 'FII NET',     fmt: 'signed-cr', align: 'right', bold: true },
        { key: 'dii_buy',    label: 'DII BUY',     fmt: 'cr',        align: 'right' },
        { key: 'dii_sell',   label: 'DII SELL',    fmt: 'cr',        align: 'right' },
        { key: 'dii_net',    label: 'DII NET',     fmt: 'signed-cr', align: 'right', bold: true },
      ]}
      aggregations={[
        { key: 'fii_buy',  fmt: 'cr' },
        { key: 'fii_sell', fmt: 'cr' },
        { key: 'fii_net',  fmt: 'signed-cr' },
        { key: 'dii_buy',  fmt: 'cr' },
        { key: 'dii_sell', fmt: 'cr' },
        { key: 'dii_net',  fmt: 'signed-cr' },
      ]}
      exportFilename={({ from, to }) => `fii_dii_${from || 'all'}_to_${to || 'now'}.csv`}
    />
    </>
  )
}

export default FiiDii
