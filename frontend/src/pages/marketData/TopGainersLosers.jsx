import MarketDataTable from '../../components/MarketDataTable'

// NSE top gainers and losers by index. Same row schema for both directions —
// the category filter chooses which side to show.
function TopGainersLosers() {
  return (
    <MarketDataTable
      title="Top Gainers / Losers"
      description="Daily top price-movers per index, sourced from NSE's live-analysis variations endpoint. Filter by gainer/loser and pick the index segment."
      endpoint="/api/top-gainers-losers"
      dateField="trade_date"
      defaultPreset="7d"
      defaultPageSize={50}
      searchableFields={['symbol']}
      filterFields={[
        {
          key: 'category',
          label: 'Direction',
          queryParam: 'category',
          options: [
            { value: 'GAINER', label: 'Gainers' },
            { value: 'LOSER',  label: 'Losers'  },
          ],
        },
        {
          key: 'index_name',
          label: 'Index',
          queryParam: 'index_name',
          options: [
            { value: 'allSec',                label: 'All Securities'     },
            { value: 'NIFTY',                 label: 'NIFTY 50'           },
            { value: 'BANKNIFTY',             label: 'BANK NIFTY'         },
            { value: 'NIFTYNEXT50',           label: 'NIFTY Next 50'      },
            { value: 'NIFTYMID100',           label: 'NIFTY Midcap 100'   },
            { value: 'NIFTYSMLCAP100',        label: 'NIFTY Smallcap 100' },
            { value: 'SecGtr20',              label: 'Securities > 20%'   },
            { value: 'SecLwr20',              label: 'Securities < −20%'  },
          ],
        },
      ]}
      rowKey={(r, i) => `${r.trade_date}-${r.symbol}-${r.index_name}-${r.category}-${i}`}
      initialSort={{ key: 'pct_change', dir: 'desc' }}
      columns={[
        { key: 'trade_date',      label: 'DATE',       fmt: 'date',     bold: true },
        { key: 'symbol',          label: 'SYMBOL',     bold: true, linkable: 'symbol' },
        { key: 'series',          label: 'SERIES' },
        { key: 'ltp',             label: 'LTP',        fmt: 'currency', align: 'right' },
        { key: 'prev_price',      label: 'PREV',       fmt: 'currency', align: 'right' },
        { key: 'net_change',      label: 'NET',        fmt: 'currency', align: 'right',
          color: (v) => v == null ? 'var(--text-secondary)' : v > 0 ? '#10b981' : v < 0 ? '#ef4444' : 'var(--text-secondary)' },
        { key: 'pct_change',      label: '%',          fmt: 'percent',  align: 'right', bold: true },
        { key: 'trade_quantity',  label: 'VOL',        fmt: 'number',   align: 'right' },
        { key: 'turnover',        label: 'TURNOVER',   fmt: 'number',   align: 'right' },
        { key: 'index_name',      label: 'INDEX',      fmt: (v) => v || '—' },
      ]}
      exportFilename={({ from, to, filterState }) =>
        `top_${(filterState.category || 'all').toLowerCase()}_${filterState.index_name || 'allSec'}_${from || 'all'}_to_${to || 'now'}.csv`}
    />
  )
}

export default TopGainersLosers
