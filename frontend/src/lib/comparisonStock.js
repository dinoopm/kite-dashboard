export function comparisonStockDefinition(stock, market) {
  if (!stock?.symbol) return null
  if (market === 'IN' && (!/^\d+$/.test(String(stock.token || '')) || Number(stock.token) <= 0)) return null
  return { id: 'comparisonStock', symbol: stock.symbol, token: market === 'IN' ? String(stock.token) : null,
    key: market === 'IN' ? `${stock.exchange}:${stock.symbol}` : stock.symbol,
    label: market === 'IN' ? `${stock.symbol} (${stock.exchange})` : stock.symbol, color: '#60a5fa' }
}

export function comparisonSearchUrl(market, query) {
  return `${market === 'US' ? '/api/us/search' : '/api/search-instruments'}?q=${encodeURIComponent(query.trim())}`
}

export function parseComparisonStocks(payload, market, exclude) {
  if (payload?.error) throw new Error(payload.error)
  if (!Array.isArray(payload?.results)) throw new Error('Stock search returned an invalid response')
  const seen = new Set()
  return payload.results.filter(stock => {
    if (!comparisonStockDefinition(stock, market)) return false
    const key = market === 'IN' ? String(stock.token) : stock.symbol
    if (key === String(exclude) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}
