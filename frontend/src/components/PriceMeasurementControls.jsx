export default function PriceMeasurementControls({ model, disabled = false }) {
  const { state, toggle, clear } = model;
  return <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap', marginBottom: '0.75rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
    <button type="button" aria-pressed={state.active} disabled={disabled} onClick={toggle} title="Measure the price and percentage change between two chart points" style={{ padding: '0.4rem 0.75rem', borderRadius: '5px', border: `1px solid ${state.active ? '#38bdf8' : 'var(--border)'}`, background: state.active ? 'rgba(56,189,248,0.15)' : 'transparent', color: state.active ? '#38bdf8' : 'var(--text-primary)', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: '0.78rem' }}>📏 Measure price</button>
    {(state.active || state.start) && <button type="button" onClick={clear} style={{ border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.75rem' }}>Clear measurement</button>}
    <span role="status">{state.active ? (state.start ? 'Click the end point · Esc to cancel' : 'Click the start point · Esc to cancel') : state.end ? 'Measure price to start again · Esc to clear' : 'Select two points to measure price and % change'}</span>
  </div>;
}
