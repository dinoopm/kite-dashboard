import MarketDataTable from '../../components/MarketDataTable'

// NSE bulk and block deal disclosures — large notional trades (≥ 0.5% of
// equity for bulk, fixed quantity for block) by named entities.
function LargeDeals() {
  return (
    <MarketDataTable
      title="Large Deals"
      description="NSE bulk and block deal disclosures — large notional trades by named entities (clients, funds, promoters). Source: NSE, daily sync."
      endpoint="/api/large-deals"
      dateField="trade_date"
      defaultPreset="30d"
      searchableFields={['symbol', 'client_name']}
      filterFields={[
        {
          key: 'deal_category',
          label: 'Category',
          queryParam: 'deal_category',
          options: [
            { value: '',      label: 'All'   },
            { value: 'Bulk',  label: 'Bulk'  },
            { value: 'Block', label: 'Block' },
          ],
        },
      ]}
      rowKey={(r, i) => `${r.trade_date}-${r.symbol}-${r.client_name}-${i}`}
      initialSort={{ key: 'trade_date', dir: 'desc' }}
      columns={[
        { key: 'trade_date',     label: 'DATE',        fmt: 'date',     bold: true },
        { key: 'symbol',         label: 'SYMBOL',      bold: true, linkable: 'symbol' },
        { key: 'client_name',    label: 'CLIENT' },
        { key: 'deal_type',      label: 'TYPE',
          color: (v) => v === 'BUY' || v === 'Buy' ? '#10b981' : v === 'SELL' || v === 'Sell' ? '#ef4444' : '#cbd5e1' },
        { key: 'quantity',       label: 'QTY',         fmt: 'number',   align: 'right' },
        { key: 'price',          label: 'PRICE',       fmt: 'currency', align: 'right' },
        { key: 'deal_category',  label: 'CATEGORY' },
      ]}
      exportFilename={({ from, to }) => `large_deals_${from || 'all'}_to_${to || 'now'}.csv`}
    />
  )
}

export default LargeDeals
