const LABELS = { nfci: 'Financial conditions', credit: 'Credit spreads', realYield: 'Real yields' }
const current = signal => signal?.status === 'available' && !signal.stale && Number.isFinite(signal.value)

export function equityDecision(signals = [], index = 'sp500') {
  const selected = ['nfci', 'credit', 'realYield', index].map(id => signals.find(signal => signal.id === id))
  const [nfci, credit, realYield, trend] = selected
  const usable = selected.filter(current).length
  const supports = [], cautions = []
  if (current(nfci)) (nfci.value < 0 ? supports : cautions).push(nfci.value < 0 ? 'Financial conditions are looser than average.' : 'Financial conditions are at or tighter than average.')
  for (const signal of [credit, realYield]) {
    if (!current(signal) || !Number.isFinite(signal.change3m?.value)) continue
    const change = signal.change3m.value
    const title = LABELS[signal.id]
    const wording = signal.id === 'credit' ? change > 0 ? 'widening' : change < 0 ? 'narrowing' : 'unchanged' : change > 0 ? 'rising' : change < 0 ? 'falling' : 'unchanged'
    ;(change <= 0 ? supports : cautions).push(`${title} are ${wording} over three months.`)
  }
  if (current(trend) && Number.isFinite(trend.distanceFromAveragePct)) (trend.distanceFromAveragePct > 0 ? supports : cautions).push(`${trend.title.replace(' trend', '')} is ${trend.distanceFromAveragePct > 0 ? 'above' : trend.distanceFromAveragePct < 0 ? 'below' : 'at'} its 200-day average.`)
  const complete = usable === 4 && Number.isFinite(credit.change3m?.value) && Number.isFinite(realYield.change3m?.value) && Number.isFinite(trend.distanceFromAveragePct)
  if (!complete) return { state: 'incomplete', title: 'Assessment incomplete', action: 'Wait for fresh readings', summary: `${usable} of 4 required readings are current. Missing or older data cannot count as confirmation.`, supports, cautions, selected, usable }
  const above = trend.distanceFromAveragePct > 0
  const stressed = credit.change3m.value > 0 || nfci.value >= 0
  if (!above && stressed) return { state: 'defensive', title: 'Defensive backdrop', action: 'Prioritize risk control', summary: 'The index is at or below its 200-day average, with widening credit spreads or tight financial conditions.', supports, cautions, selected, usable }
  if (above && nfci.value < 0 && credit.change3m.value <= 0 && realYield.change3m.value <= 0) return { state: 'supportive', title: 'Provisionally supportive', action: 'Check earnings and breadth before adding risk', summary: 'The price trend and financing conditions support each other. Earnings and market breadth still need confirmation.', supports, cautions, selected, usable }
  return { state: 'caution', title: 'Mixed backdrop · caution', action: 'Wait for stronger confirmation', summary: 'The readings do not all support taking more equity risk. Review the conflicting signals below.', supports, cautions, selected, usable }
}
