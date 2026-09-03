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
  // A bearish signal is a warning, and a warning that worked must never be
  // green: green means "beat the index" everywhere else in this app, and next
  // to a marker saying do-not-buy it would read as the opposite of what it
  // measures. Amber — the dead cat's own colour on the chart — for a warning
  // that held; grey for one the data refused to support, which is a signal
  // being wrong, not a loss being made.
  held:          { color: '#fbbf24', border: 'rgba(251,191,36,0.35)', bg: 'rgba(251,191,36,0.10)' },
  refuted:       { color: 'var(--text-secondary)', border: 'var(--border)', bg: 'transparent' },
}

// Everything in signal_emissions comes from nse_bhavcopy and is scored against
// NIFTY 50. That is a fact about the DATA, not a detail of presentation: a
// number measured on Indian prices, rendered beside a US chart, is a false
// provenance however carefully it is captioned. So a non-Indian market gets an
// explicitly empty record instead of a borrowed one — which still satisfies the
// rule that an unvalidated signal must LOOK unvalidated.
const NO_RECORD = {
  state: 'unscoreable',
  text: 'not measured here',
  detail: 'The scorecard is built from nse_bhavcopy and scored against NIFTY 50, so every figure in it was measured on Indian prices. Nothing has been measured on US prices, and showing the Indian number here would attach it to a market it says nothing about.\n\nbackend/volumeThrustStudy.js (the volume-confirmed cross) and backend/deadCatStudy.js (the dead-cat bounce) ask the same questions of a decade of US history — run those for the US answer. Their results are not wired into this badge.',
}

/**
 * @param {string} signal  registry name, e.g. 'breakout_20d'
 * @param {string} [label] leading text; defaults to "Track record"
 * @param {string} [market] which market the SIGNAL IS BEING SHOWN ON, not which
 *   one it was scored on. Anything other than 'IN' has no record to show.
 */
export default function SignalScore({ signal, label, source, style, market = 'IN' }) {
  const { entry, error, loading } = useSignalScore(signal, { source })

  // Hooks first, then branch — the lookup is thrown away off the Indian
  // market, but it must still run on every render.
  if (market !== 'IN') return <Badge tone={TONE.unscoreable} label={label} headline={NO_RECORD} style={style} />

  if (loading) return null
  // A failed scorecard fetch must not shout on top of the signal it annotates —
  // the signal is still usable, we just cannot say whether it works.
  if (error || !entry) return null

  const h = entry.headline
  const detail = [
    h.detail,
    entry.description,
    entry.firings ? `${entry.firings} firings across ${entry.symbols} symbols since ${entry.firstFired}.` : null,
    entry.source === 'reconstructed'
      ? 'Reconstructed from stored daily prices — faithful, but assembled after the fact.'
      : 'Recorded the day it fired, before the outcome existed.',
  ].filter(Boolean).join('\n\n')

  return <Badge tone={TONE[h.state] || TONE['no-data']} label={label} headline={h} detail={detail} style={style} />
}

function Badge({ tone, label, headline, detail, style }) {
  return (
    <span
      title={detail || headline.detail}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
        padding: '0.12rem 0.45rem', borderRadius: '5px',
        border: `1px solid ${tone.border}`, background: tone.bg, color: tone.color,
        fontSize: '0.65rem', fontWeight: 600, whiteSpace: 'nowrap', cursor: 'help',
        ...style,
      }}
    >
      <span style={{ opacity: 0.75, fontWeight: 500 }}>{label || 'Track record'}</span>
      {headline.text}
    </span>
  )
}
