import MarketDataTable from '../../components/MarketDataTable'
import SignalScore from '../../components/SignalScore'

// NSE 52-week high/low daily snapshot — stocks at or near their yearly extremes.
function Week52HighLow() {
  return (
    <MarketDataTable
      title="52-Week High / Low"
      description="Daily snapshot of NSE equities and their adjusted 52-week high/low levels, with the dates those extremes were set. Source: NSE archive CSV, daily sync."
      // A new 52-week high is read as strength, so the list is a buy cue. Its
      // record (high_52w, recorded the day NSE reports the high) rides with it.
      headerExtra={
        <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          Is a new 52-week high a buy signal here?
          <SignalScore signal="high_52w" label="New 52-week high" market="IN" />
        </span>
      }
      endpoint="/api/52wk-high-low"
      dateField="trade_date"
      defaultPreset="7d"
      defaultPageSize={50}
      searchableFields={['symbol', 'company_name']}
      filterFields={[
        {
          key: 'series',
          label: 'Series',
          queryParam: 'series',
          options: [
            { value: '',   label: 'All' },
            { value: 'EQ', label: 'EQ'  },
            { value: 'BE', label: 'BE'  },
            { value: 'BZ', label: 'BZ'  },
          ],
        },
      ]}
      rowKey={(r) => `${r.trade_date}-${r.symbol}-${r.series}`}
      initialSort={{ key: 'trade_date', dir: 'desc' }}
      columns={[
        { key: 'trade_date',             label: 'DATE',     fmt: 'date',     bold: true },
        { key: 'symbol',                 label: 'SYMBOL',   bold: true, linkable: 'symbol' },
        { key: 'series',                 label: 'SERIES' },
        { key: 'company_name',           label: 'COMPANY' },
        { key: 'adjusted_52_week_high',  label: '52W HIGH', fmt: 'currency', align: 'right', color: '#10b981' },
        { key: 'high_date',              label: 'HIGH ON',  fmt: 'date',     align: 'right' },
        { key: 'adjusted_52_week_low',   label: '52W LOW',  fmt: 'currency', align: 'right', color: '#ef4444' },
        { key: 'low_date',               label: 'LOW ON',   fmt: 'date',     align: 'right' },
      ]}
      exportFilename={({ from, to }) => `52wk_high_low_${from || 'all'}_to_${to || 'now'}.csv`}
    />
  )
}

export default Week52HighLow
