// The reference is public. Applying it locally keeps existing authenticated
// broker sessions usable while the updated backend rolls out.
export function withMarketCapRisk(data, catalog) {
  if (data.marketCapitalization?.status === 'available' || !catalog?.records?.length) return data
  const byIsin = new Map(), bySymbol = new Map()
  for (const record of catalog.records) {
    byIsin.set(record.isin, record)
    for (const [exchange, symbol] of [['NSE', record.nse], ['BSE', record.bse]]) {
      if (!symbol) continue
      const key = `${exchange}:${symbol}`
      bySymbol.set(key, bySymbol.has(key) ? null : record)
    }
  }
  const groups = ['Large Cap', 'Mid Cap', 'Small Cap', 'Unknown'].map(category => ({ category, currentValue: 0, holdingCount: 0, symbols: [], weightPct: 0 }))
  const total = Number(data.summary?.coveredValue) || 0
  const positions = (data.positions || []).map(position => {
    const symbol = String(position.symbol || '').trim().toUpperCase().replace(/-(BE|SM|EQ)$/, '')
    const match = position.isin ? byIsin.get(position.isin) : bySymbol.get(`${position.exchange}:${symbol}`)
    const category = match?.category || 'Unknown'
    const group = groups.find(item => item.category === category) || groups[3]
    group.currentValue += position.currentValue
    group.holdingCount++
    group.symbols.push(position.symbol)
    return { ...position, marketCapCategory: group.category, marketCapRank: match?.rank ?? null, averageMarketCapCr: match?.averageMarketCapCr ?? null }
  })
  for (const group of groups) group.weightPct = total > 0 ? group.currentValue / total * 100 : 0
  return { ...data, positions, marketCapitalization: { groups, classifiedValue: total - groups[3].currentValue, classificationCoveragePct: total > 0 ? (total - groups[3].currentValue) / total * 100 : 0, midSmallWeightPct: groups[1].weightPct + groups[2].weightPct, source: 'AMFI', sourceUrl: catalog.sourceUrl, periodEnd: catalog.periodEnd, fetchedAt: catalog.fetchedAt, status: 'available' } }
}
