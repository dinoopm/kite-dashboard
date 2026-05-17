import MarketDataTable from '../../components/MarketDataTable'

// NSE surveillance list — stocks under ASM (Additional Surveillance Measure)
// or GSM (Graded Surveillance Measure). This is a live list, not time-series,
// so the date filter is disabled.
function SurveillanceStocks() {
  return (
    <MarketDataTable
      title="Surveillance Stocks (ASM / GSM)"
      description="NSE Additional Surveillance Measure (ASM) and Graded Surveillance Measure (GSM) lists. Stocks here face stricter circuit limits, higher margin requirements, or T+2T settlement — handle with extra care."
      endpoint="/api/surveillance"
      dateField={null}
      searchableFields={['symbol']}
      defaultPageSize={50}
      filterFields={[
        {
          key: 'measure',
          label: 'Measure',
          queryParam: 'measure',
          options: [
            { value: '',    label: 'All' },
            { value: 'ASM', label: 'ASM' },
            { value: 'GSM', label: 'GSM' },
          ],
        },
      ]}
      rowKey={(r, i) => `${r.symbol}-${r.measure}-${i}`}
      initialSort={{ key: 'symbol', dir: 'asc' }}
      columns={[
        { key: 'symbol',  label: 'SYMBOL',  bold: true, linkable: 'symbol' },
        { key: 'measure', label: 'MEASURE',
          color: (v) => v === 'ASM' ? '#fcd34d' : v === 'GSM' ? '#fb7185' : 'var(--text-secondary)' },
        { key: 'stage',   label: 'STAGE' },
      ]}
      exportFilename={({ filterState }) =>
        `surveillance_${(filterState.measure || 'all').toLowerCase()}.csv`}
    />
  )
}

export default SurveillanceStocks
