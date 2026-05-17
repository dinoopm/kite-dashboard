import MarketDataTable from '../../components/MarketDataTable'

// NSE volume gainers — stocks with unusual volume relative to their 1-week
// and 2-week averages. Useful for spotting accumulation early.
function VolumeGainers() {
  return (
    <MarketDataTable
      title="Volume Gainers"
      description="Stocks with unusually high volume vs their 1-week and 2-week averages — often a leading indicator of accumulation, breakouts, or news flow. Source: NSE live-analysis-volume."
      endpoint="/api/volume-gainers"
      dateField="trade_date"
      defaultPreset="7d"
      defaultPageSize={50}
      searchableFields={['symbol', 'company_name']}
      rowKey={(r) => `${r.trade_date}-${r.symbol}`}
      initialSort={{ key: 'week1_vol_change', dir: 'desc' }}
      columns={[
        { key: 'trade_date',         label: 'DATE',       fmt: 'date',     bold: true },
        { key: 'symbol',             label: 'SYMBOL',     bold: true, linkable: 'symbol' },
        { key: 'company_name',       label: 'COMPANY' },
        { key: 'volume',             label: 'TODAY VOL',  fmt: 'number',   align: 'right' },
        { key: 'week1_avg_volume',   label: '1W AVG',     fmt: 'number',   align: 'right' },
        { key: 'week1_vol_change',   label: '× 1W AVG',   fmt: 'percent',  align: 'right', bold: true },
        { key: 'week2_avg_volume',   label: '2W AVG',     fmt: 'number',   align: 'right' },
        { key: 'week2_vol_change',   label: '× 2W AVG',   fmt: 'percent',  align: 'right' },
        { key: 'ltp',                label: 'LTP',        fmt: 'currency', align: 'right' },
        { key: 'pct_change',         label: 'DAY %',      fmt: 'percent',  align: 'right' },
        { key: 'turnover',           label: 'TURNOVER',   fmt: 'number',   align: 'right' },
      ]}
      exportFilename={({ from, to }) => `volume_gainers_${from || 'all'}_to_${to || 'now'}.csv`}
    />
  )
}

export default VolumeGainers
