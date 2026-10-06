export const COMPARISON_INDICES = [
  { id: 'nifty50', key: 'NSE:NIFTY 50', label: 'Nifty 50', color: '#fbbf24' },
  { id: 'smallcap250', key: 'NSE:NIFTY SMLCAP 250', label: 'Nifty Smallcap 250', color: '#a78bfa' },
  { id: 'midcap100', key: 'NSE:NIFTY MIDCAP 100', label: 'Nifty Midcap 100', color: '#fb7185' },
]

const positive = value => value !== null && value !== '' && ![undefined, true, false].includes(value) && Number.isFinite(Number(value)) && Number(value) > 0
export const percentageChange = (value, base) => positive(value) && positive(base) ? (Number(value) / Number(base) - 1) * 100 : null

function timeKey(bar, intraday) {
  const stamp = bar?.timestamp ?? bar?.date
  if (typeof stamp !== 'string') return null
  if (!intraday) return /^\d{4}-\d{2}-\d{2}/.test(stamp) ? stamp.slice(0, 10) : null
  const millis = Date.parse(stamp)
  return Number.isFinite(millis) ? String(millis) : null
}

// Use actual matching sessions only. Missing sessions are gaps, never a
// carried-forward index value. Every plotted series shares one baseline.
export function buildIndexComparison(stock, benchmarks, intraday = false) {
  const rows = stock.filter(bar => positive(bar?.close) && timeKey(bar, intraday))
  const firstKey = rows[0] && timeKey(rows[0], intraday)
  const lastKey = rows.at(-1) && timeKey(rows.at(-1), intraday)
  const maps = Object.entries(benchmarks).map(([id, bars]) => [id, new Map(
    bars.filter(bar => positive(bar?.close)).map(bar => [timeKey(bar, intraday), Number(bar.close)])
  )]).filter(([, map]) => rows.some(bar => map.has(timeKey(bar, intraday))))
  const start = maps.length ? rows.findIndex(bar => maps.every(([, map]) => map.has(timeKey(bar, intraday)))) : -1
  if (start < 0) return { data: stock, indices: [], base: null, unavailable: Object.keys(benchmarks) }
  const baseline = timeKey(rows[start], intraday)
  const base = Number(rows[start].close)
  const indices = maps.map(([id]) => id)
  return {
    base, startDate: rows[start].date, shortened: baseline !== firstKey,
    endMissing: maps.filter(([, map]) => !map.has(lastKey)).map(([id]) => id),
    indices, unavailable: Object.keys(benchmarks).filter(id => !indices.includes(id)),
    data: rows.slice(start).map(bar => {
      const key = timeKey(bar, intraday)
      return { ...bar, stockReturn: percentageChange(bar.close, base), ...Object.fromEntries(
        maps.map(([id, map]) => [id, percentageChange(map.get(key), map.get(baseline))])
      ) }
    }),
  }
}

export function parseKiteResponse(payload) {
  if (payload?.isError || payload?.error) throw new Error(payload.error || payload.content?.[0]?.text || 'Index data unavailable')
  const text = payload?.content?.find(item => item.type === 'text' || item.text)?.text
  if (!text) throw new Error('Index data response is incomplete')
  return JSON.parse(text)
}
