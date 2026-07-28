import { useSignalScore } from '../lib/useSignalScore'

// ─── Track-record badge ──────────────────────────────────────────────────────
//
// Renders beside a signal, not on a separate validation page. The separation was
// the problem: a breakout filter looks authoritative on its own, and the only
// place saying whether breakouts have actually worked was a panel nobody opens.
// Putting the number where the claim is made is the whole point.
//
// The badge never flatters. It shows excess over NIFTY rather than raw return,
// stays grey and says "too few to judge" below the sample floor, and renders
// negative edges in the same size type as positive ones.

const TONE = {
  positive:      { color: '#34d399', border: 'rgba(52,211,153,0.35)', bg: 'rgba(52,211,153,0.10)' },
  negative:      { color: '#fca5a5', border: 'rgba(252,165,165,0.35)', bg: 'rgba(252,165,165,0.10)' },
  thin:          { color: 'var(--text-secondary)', border: 'var(--border)', bg: 'transparent' },
  'no-data':     { color: 'var(--text-secondary)', border: 'var(--border)', bg: 'transparent' },
  'no-benchmark':{ color: 'var(--text-secondary)', border: 'var(--border)', bg: 'transparent' },
  unscoreable:   { color: '#fcd34d', border: 'rgba(252,211,77,0.35)', bg: 'rgba(252,211,77,0.08)' },
}

/**
 * @param {string} signal  registry name, e.g. 'breakout_20d'
 * @param {string} [label] leading text; defaults to "Track record"
 */
export default function SignalScore({ signal, label, source, style }) {
  const { entry, error, loading } = useSignalScore(signal, { source })

  if (loading) return null
  // A failed scorecard fetch must not shout on top of the signal it annotates —
  // the signal is still usable, we just cannot say whether it works.
  if (error || !entry) return null

  const h = entry.headline
  const tone = TONE[h.state] || TONE['no-data']
  const detail = [
    h.detail,
    entry.description,
    entry.firings ? `${entry.firings} firings across ${entry.symbols} symbols since ${entry.firstFired}.` : null,
    entry.source === 'reconstructed'
      ? 'Reconstructed from stored daily prices — faithful, but assembled after the fact.'
      : 'Recorded the day it fired, before the outcome existed.',
  ].filter(Boolean).join('\n\n')

  return (
    <span
      title={detail}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
        padding: '0.12rem 0.45rem', borderRadius: '5px',
        border: `1px solid ${tone.border}`, background: tone.bg, color: tone.color,
        fontSize: '0.65rem', fontWeight: 600, whiteSpace: 'nowrap', cursor: 'help',
        ...style,
      }}
    >
      <span style={{ opacity: 0.75, fontWeight: 500 }}>{label || 'Track record'}</span>
      {h.text}
    </span>
  )
}
