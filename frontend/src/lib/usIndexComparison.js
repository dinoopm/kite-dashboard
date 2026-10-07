export const US_COMPARISON_INDICES = [
  { id: 'sp500', symbol: 'SPY', label: 'S&P 500 (SPY)', color: '#fbbf24' },
  { id: 'nasdaq100', symbol: 'QQQ', label: 'Nasdaq 100 (QQQ)', color: '#a78bfa' },
  { id: 'russell2000', symbol: 'IWM', label: 'Russell 2000 (IWM)', color: '#fb7185' },
]

// Identical range/session parameters for stock and proxies, including weekly
// bars on 5Y and 15-minute timestamps on 1D. No separate resampling or filling.
export function usBarsUrl(symbol, range, extended = false) {
  return `/api/us/bars/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}${range === '1D' && extended ? '&extended=1' : ''}`
}

export function parseUsComparisonBars(payload) {
  if (payload?.error) throw new Error(payload.error)
  if (!Array.isArray(payload?.bars) || !payload.bars.length) throw new Error('No comparison history for this timeframe')
  if (!payload.bars.every(bar => typeof bar?.date === 'string' && Number.isFinite(Date.parse(bar.date))
    && bar.close !== null && bar.close !== '' && typeof bar.close !== 'boolean'
    && Number.isFinite(Number(bar.close)) && Number(bar.close) > 0)) {
    throw new Error('Comparison history contains invalid dates or prices')
  }
  return payload.bars
}

export async function fetchUsComparisonBars(symbol, range, extended, { fetcher, signal }) {
  const response = await fetcher(usBarsUrl(symbol, range, extended), { signal })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error || `Comparison history failed (${response.status})`)
  return parseUsComparisonBars(payload)
}
