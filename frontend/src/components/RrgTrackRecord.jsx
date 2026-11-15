import { useEffect, useState } from 'react'
import SignalScore from './SignalScore'

// ─── Track record of RRG rotation, beside the chart that invites the reading ──
//
// An RRG is read as a forecast — entering Leading is strength, Improving comes
// before Leading — and the chart alone gives no way to know whether that
// reading has ever paid. This row answers it where it has been measured and
// says plainly where it has not, because the same component draws three
// different charts:
//
//   us-sectors   the US sector ETFs against SPY. Scored: GET /api/rrg/scorecard
//                (backend/rrg), four badges, one per quadrant entered.
//   in-sectors   the Indian sector indices. Registered but blocked, so the
//                badge is the registry's "cannot be scored yet".
//   (default)    a drill-down's stocks against their sector. Never measured;
//                a US sector result shown here would be a borrowed number.

const QUADRANTS = ['Leading', 'Improving', 'Weakening', 'Lagging']
let cache = null
let inflight = null
function loadRotationScorecard() {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetch('/api/rrg/scorecard')
      .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); cache = j; return j })
      .finally(() => { inflight = null })
  }
  return inflight
}

// Recorded evidence wins once it can speak; until then the reconstruction is
// shown, and the tooltip says how far the recorded half has got.
const SPEAKS = new Set(['positive', 'negative', 'held', 'refuted'])
function entryFor(card, quadrant) {
  const name = `us_rrg_enter_${quadrant.toLowerCase()}`
  const recon = card.signals.find(s => s.signal === name && s.source === 'reconstructed')
  const rec = card.signals.find(s => s.signal === name && s.source === 'recorded')
  const recordedSpeaks = rec && (SPEAKS.has(rec.headline.state) || /no clear edge/.test(rec.headline.text))
  const shown = recordedSpeaks ? rec : recon
  if (!shown) return null
  const other = recordedSpeaks
    ? `Reconstructed history: ${recon?.headline.text || 'unavailable'}.`
    : `Recorded live so far: ${rec?.firings || 0} entr${rec?.firings === 1 ? 'y' : 'ies'} — not yet enough to judge by itself.`
  return { ...shown, headline: { ...shown.headline, detail: `${shown.description ? `${shown.description}\n\n` : ''}${shown.headline.detail}\n\n${other}` } }
}

const NOT_MEASURED = {
  headline: {
    state: 'unscoreable', text: 'not measured for this chart',
    detail: 'Rotation has only been scored for the US sector ETFs against SPY (the US Indices page), where entering a quadrant showed no edge that chance would not produce. This chart plots a different universe, and that result is not carried over to it. Read it as where these names have been, not where they are going.',
  },
}

const row = { display: 'flex', alignItems: 'center', gap: '0.4rem 0.6rem', flexWrap: 'wrap', marginTop: '0.9rem', fontSize: '0.72rem', color: 'var(--text-secondary)' }

export default function RrgTrackRecord({ scope, benchmarkLabel }) {
  const [card, setCard] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (scope !== 'us-sectors') return undefined
    let on = true
    loadRotationScorecard().then(j => { if (on) setCard(j) }).catch(() => { if (on) setFailed(true) })
    return () => { on = false }
  }, [scope])

  if (scope === 'in-sectors') {
    return <div style={row}><span>Does rotation predict?</span><SignalScore signal="rrg_rotation" label="Quadrant entries" /></div>
  }
  if (scope !== 'us-sectors') {
    return <div style={row}><span>Does rotation predict?</span><SignalScore signal="rrg_rotation" entry={NOT_MEASURED} label="Quadrant entries" /></div>
  }
  // A failed fetch must not shout over the chart; the chart is still usable.
  if (failed || !card) return null

  const p = card.params
  const years = `${card.coverage.firstWeek?.slice(0, 4)}–${card.coverage.lastWeek?.slice(0, 4)}`
  return (
    <div style={row}>
      <span title={(card.notes || []).join('\n')} style={{ cursor: 'help' }}>
        Does rotation predict? Median return vs {card.benchmark}, {p.headlineWeeks} weeks after a sector entered each quadrant ({years}):
      </span>
      {QUADRANTS.map(q => {
        const entry = entryFor(card, q)
        return entry ? <SignalScore key={q} signal={entry.signal} market="US" entry={entry} label={q} /> : null
      })}
      {benchmarkLabel && benchmarkLabel !== card.benchmark && (
        <span>Measured against {card.benchmark} only — not against {benchmarkLabel}.</span>
      )}
    </div>
  )
}
