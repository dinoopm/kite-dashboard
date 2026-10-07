import { COMPARISON_INDICES } from '../lib/indexComparison'
import ComparisonStockSearch from './ComparisonStockSearch'

export default function IndexComparisonControls({ model, loading, indices = COMPARISON_INDICES, returnNote = 'Price returns, excluding dividends.', sourceNote, formatStartDate = value => value }) {
  const { selected, states, comparison, toggle, retry } = model
  const allIndices = model.indices || indices
  const failed = selected.some(id => states[id]?.error)
  return <fieldset className="glass-panel" style={{ margin: '0 0 0.75rem', padding: '0.75rem 1rem', minWidth: 0 }}>
    <legend style={{ fontSize: '0.8rem', padding: '0 0.35rem' }}>Compare returns</legend>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem 1.5rem' }}>
      {indices.map(index => <label key={index.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem' }}>
        <input type="checkbox" checked={selected.includes(index.id)} onChange={() => toggle(index.id)} />
        <span style={{ color: index.color }}>━</span> {index.label}
      </label>)}
      {model.stock && <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem' }}>
        <input type="checkbox" checked={model.stock.enabled} onChange={model.stock.toggle} />
        <span style={{ color: '#60a5fa' }}>━</span> Compare another stock
      </label>}
    </div>
    {model.stock?.enabled && <ComparisonStockSearch model={model.stock} />}
    <div aria-live="polite" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.6rem' }}>
      {!selected.length ? 'Select indices to compare percentage changes over the selected timeframe.'
        : loading ? 'Loading the instrument for the selected timeframe…'
          : comparison.base ? `Change from ${formatStartDate(comparison.startDate)}: all lines start at 0% on the same date. ${returnNote}${comparison.shortened ? ' Comparison starts later because earlier shared data is unavailable.' : ''}`
            : 'The price chart remains visible until matching index history is available.'}
      {selected.map(id => {
        const label = allIndices.find(index => index.id === id).label
        const state = states[id]
        const message = state?.error || (state?.loading || !state ? 'Loading…'
          : loading ? null
          : comparison.unavailable.includes(id) ? 'No common dates in this timeframe.'
            : comparison.endMissing?.includes(id) ? 'Latest stock session is missing from index history.' : null)
        return message && <div key={id} style={{ marginTop: '0.35rem' }}>{label}: {message}</div>
      })}
      {failed && <button type="button" onClick={retry} style={{ marginTop: '0.5rem', cursor: 'pointer' }}>Retry index data</button>}
      {sourceNote && <div style={{ marginTop: '0.35rem' }}>{sourceNote}</div>}
    </div>
  </fieldset>
}
