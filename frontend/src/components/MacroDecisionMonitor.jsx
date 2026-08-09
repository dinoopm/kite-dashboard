import { useEffect, useState } from 'react'

// ─── Macro Decision Monitor ──────────────────────────────────────────────────
//
// Six months of official US macro data (FRED, redistributing BLS/BEA/EIA/Fed)
// as five sub-signals and one regime read. Terminal-style: dense, monospaced
// numbers, no illustration.
//
// The presentation rules are not cosmetic:
//
//   · The headline is a BIAS, never a forecast. "Hold bias" and "hike risk"
//     are claims about what the data leans toward; the FOMC weighs financial
//     stability, credit and global growth, none of which are inputs here.
//   · Every number is labelled with WHICH transform produced it — annualized,
//     percentage-point, or percent change — because the same "+0.7" means
//     three different things across these series, and an unlabelled figure
//     invites the reader to guess wrong.
//   · Conflicting signals are shown, not averaged away. A composite near zero
//     with wide disagreement is a different situation from one with everything
//     clustered at zero, and the confidence row is where that shows up.

const GREEN = 'var(--success)', RED = 'var(--danger)', GREY = 'var(--text-secondary)'
const AMBER = '#fbbf24'

// Cooling reads green because the panel is about INFLATION pressure, not about
// markets — falling price pressure is the "good" direction here.
const REGIME_STYLE = {
  cooling: { label: 'Cooling', color: GREEN, bias: 'Cut bias' },
  neutral: { label: 'Neutral', color: AMBER, bias: 'Hold bias' },
  reaccelerating: { label: 'Re-accelerating', color: RED, bias: 'Hike risk' },
  unknown: { label: 'Unknown', color: GREY, bias: 'No read' },
}

const SIGNAL_LABELS = {
  inflation: 'Inflation', labour: 'Labour market', wages: 'Wage pressure',
  expectations: 'Expectations', oil: 'Oil / energy',
}

// What each transform means, in the tooltip, in words rather than jargon.
const TRANSFORM_HELP = {
  index: 'Annualized: the pace of the last 3 and 6 months, projected to a year.',
  price: 'Percent change over six months.',
  rate: 'Percentage-point change over six months — this series is already a percent, so a ratio would be meaningless.',
  count: 'Average monthly change over the last three months, in the series own units.',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const fmt = (v, d = 2, suffix = '') => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(d)}${suffix}`)
const signed = (v, d = 2, suffix = '') => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}${suffix}`)
const toneOf = (v) => (v == null ? GREY : v > 0.05 ? RED : v < -0.05 ? GREEN : AMBER)

/** The six-month headline for one indicator, with its transform named. */
function headlineFor(ind) {
  if (ind.transform === 'index' && ind.annualized6m != null) {
    return { value: signed(ind.annualized6m, 2, '%'), caption: '6m annualized' }
  }
  if (ind.transform === 'rate' && ind.changePp != null) {
    return { value: signed(ind.changePp, 2, 'pp'), caption: '6m change' }
  }
  if (ind.transform === 'price' && ind.rocPct != null) {
    return { value: signed(ind.rocPct, 1, '%'), caption: '6m change' }
  }
  if (ind.transform === 'count' && ind.avg3mChange != null) {
    return { value: signed(ind.avg3mChange, 0, 'k'), caption: '3m avg / month' }
  }
  return { value: '—', caption: 'no six-month reading' }
}

function Bar({ contribution }) {
  // Contributions run roughly ±0.45 (inflation at full weight), so ±0.5 is the
  // full-width scale.
  const pct = contribution == null ? 0 : Math.min(100, Math.abs(contribution) / 0.5 * 100)
  const positive = (contribution || 0) >= 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: 8, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ width: '50%', display: 'flex', justifyContent: 'flex-end' }}>
        {!positive && <div style={{ width: `${pct}%`, height: 8, background: GREEN }} />}
      </div>
      <div style={{ width: '50%' }}>
        {positive && <div style={{ width: `${pct}%`, height: 8, background: RED }} />}
      </div>
    </div>
  )
}

export default function MacroDecisionMonitor() {
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  const [loading, setLoading] = useState(true)
  const [openHelp, setOpenHelp] = useState(null)

  useEffect(() => {
    let on = true
    fetch('/api/macro/monitor')
      .then(r => r.json())
      .then(j => { if (!on) return; if (j.error) setErr(j.error); else setD(j) })
      .catch(e => on && setErr(e.message))
      .finally(() => on && setLoading(false))
    return () => { on = false }
  }, [])

  if (loading) return <div className="loader" />
  if (err) return <div className="glass-panel" style={{ padding: '1.5rem', color: RED }}>Macro monitor unavailable: {err}</div>
  if (!d) return null

  const regime = REGIME_STYLE[d.composite.regime] || REGIME_STYLE.unknown
  const conf = d.confidence.level
  const confColor = conf === 'high' ? GREEN : conf === 'medium' ? AMBER : RED
  // Scored series first, then the context-only ones. They stay on screen —
  // Michigan expectations and headline CPI are worth seeing — but carrying a
  // tag, because listing them identically to the scored series is what made a
  // reviewer conclude a stale survey print was dragging the Expectations
  // component. It never fed it.
  const rows = [...d.indicators.filter(i => i.scored), ...d.indicators.filter(i => !i.scored)]

  const cell = { padding: '0.45rem 0.7rem', fontSize: '0.8rem', fontVariantNumeric: 'tabular-nums' }
  const th = { ...cell, color: GREY, textTransform: 'uppercase', fontSize: '0.68rem', letterSpacing: '0.05em', textAlign: 'left', fontWeight: 600 }

  return (
    <div className="glass-panel" style={{ padding: '1rem', marginBottom: '1.25rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.5rem' }}>
        <h2 style={{ margin: 0, fontSize: '1rem', letterSpacing: '0.02em' }}>Macro Decision Monitor</h2>
        <span style={{ fontSize: '0.68rem', color: GREY }}>
          US · six-month window · {d.dataPath === 'database' ? 'stored vintages' : 'live from FRED'}
        </span>
      </div>

      {/* Headline regime */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '1.5rem', alignItems: 'center',
        margin: '0.9rem 0', padding: '0.85rem 1rem',
        border: `1px solid ${regime.color}55`, background: `${regime.color}0f`, borderRadius: 8,
      }}>
        <div>
          <div style={{ fontSize: '0.66rem', color: GREY, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Regime</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, color: regime.color, lineHeight: 1.25 }}>{regime.label}</div>
          <div style={{ fontSize: '0.8rem', color: regime.color }}>{regime.bias}</div>
        </div>
        <div>
          <div style={{ fontSize: '0.66rem', color: GREY, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Score</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{signed(d.composite.score, 3)}</div>
          <div style={{ fontSize: '0.7rem', color: GREY }}>−1 cooling · +1 re-accelerating</div>
        </div>
        <div>
          <div style={{ fontSize: '0.66rem', color: GREY, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Confidence</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, color: confColor, textTransform: 'capitalize' }}>{conf}</div>
          <div style={{ fontSize: '0.7rem', color: GREY }}>
            fresh {fmt(d.confidence.freshness * 100, 0, '%')} · agree {fmt(d.confidence.agreement * 100, 0, '%')} · cover {fmt(d.composite.coverage * 100, 0, '%')}
          </div>
        </div>
        {d.releases?.next && (
          <div>
            <div style={{ fontSize: '0.66rem', color: GREY, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Next release</div>
            <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>{d.releases.next.title}</div>
            <div style={{ fontSize: '0.7rem', color: GREY }}>
              {d.releases.next.date} · {d.releases.next.daysAway === 0 ? 'today' : `${d.releases.next.daysAway}d`}
            </div>
          </div>
        )}
      </div>

      {/* Contribution breakdown. A component computed from a subset of its
          declared inputs says so — a full-looking score built on half its
          series is the thing this panel must never render silently. */}
      <div style={{ display: 'grid', gap: '0.4rem', marginBottom: '1rem' }}>
        {d.composite.contributions.map(c => {
          const sig = d.signals[c.key] || {}
          const partial = sig.inputsTotal > 0 && sig.inputsUsed < sig.inputsTotal
          return (
            <div key={c.key}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 1fr) 2.6fr auto', gap: '0.6rem', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', color: GREY }}>
                  {SIGNAL_LABELS[c.key]} <span style={{ opacity: 0.6 }}>{Math.round(c.weight * 100)}%</span>
                </span>
                <Bar contribution={c.contribution} />
                <span style={{ fontSize: '0.75rem', fontVariantNumeric: 'tabular-nums', color: toneOf(c.score), minWidth: 52, textAlign: 'right' }}>
                  {c.score == null ? 'n/a' : signed(c.score)}
                </span>
              </div>
              <div style={{ fontSize: '0.63rem', color: partial ? AMBER : GREY, paddingLeft: '0.1rem', marginTop: '0.1rem' }}>
                {sig.usedSeries?.length ? sig.usedSeries.join(' + ') : (sig.reason || 'no inputs')}
                {sig.inputsTotal > 0 && ` · based on ${sig.inputsUsed} of ${sig.inputsTotal} series`}
                {partial && sig.excluded?.length ? ` (${sig.excluded.join(', ')} excluded)` : ''}
              </div>
            </div>
          )
        })}
      </div>

      {/* Indicators */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
          <thead>
            <tr>
              <th style={th}>Indicator</th>
              <th style={{ ...th, textAlign: 'right' }}>Latest</th>
              <th style={{ ...th, textAlign: 'right' }}>Six-month</th>
              <th style={{ ...th, textAlign: 'right' }}>Reference</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(ind => {
              const h = headlineFor(ind)
              return (
                <tr key={ind.seriesId} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={cell}>
                    <button
                      onClick={() => setOpenHelp(openHelp === ind.seriesId ? null : ind.seriesId)}
                      style={{ background: 'none', border: 'none', padding: 0, color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.8rem', textAlign: 'left' }}
                      title={TRANSFORM_HELP[ind.transform]}
                    >
                      {ind.label}
                      {!ind.scored && <span style={{ color: GREY, fontWeight: 400 }}> · context only, not scored</span>}
                    </button>
                    <div style={{ fontSize: '0.65rem', color: GREY }}>
                      {ind.source} · <span style={{ fontFamily: 'ui-monospace, monospace' }}>{ind.seriesId}</span>
                      {ind.releasesBehind > 0 && <span style={{ color: AMBER }}> · {ind.releasesBehind} release behind</span>}
                    </div>
                    {/* The three first differences behind a "3m avg / month".
                        Total nonfarm and private payrolls diverge — over
                        May-Jul 2026, PAYEMS averaged +20k while USPRIV averaged
                        +40.3k — so the underlying months have to be visible for
                        the headline to be checkable. */}
                    {ind.monthlyChanges?.length > 0 && (
                      <div style={{ fontSize: '0.63rem', color: GREY, marginTop: '0.15rem', fontVariantNumeric: 'tabular-nums' }}>
                        {ind.monthlyChanges.map(c => `${MONTHS[+c.date.slice(5, 7) - 1]} ${c.change >= 0 ? '+' : ''}${Math.round(c.change)}k`).join(' · ')}
                      </div>
                    )}
                    {openHelp === ind.seriesId && (
                      <div style={{ fontSize: '0.68rem', color: GREY, marginTop: '0.3rem', maxWidth: 420, lineHeight: 1.5 }}>
                        {TRANSFORM_HELP[ind.transform]} {ind.note}
                      </div>
                    )}
                  </td>
                  <td style={{ ...cell, textAlign: 'right' }}>
                    {fmt(ind.latest, ind.transform === 'count' ? 0 : 2)}
                    <div style={{ fontSize: '0.63rem', color: GREY }}>{ind.unit}</div>
                  </td>
                  <td style={{ ...cell, textAlign: 'right', fontWeight: 600 }}>
                    {h.value}
                    <div style={{ fontSize: '0.63rem', color: GREY }}>{h.caption}</div>
                  </td>
                  <td style={{ ...cell, textAlign: 'right', color: GREY, fontSize: '0.72rem' }}>
                    {ind.latestDate || '—'}
                    {ind.sixMonthsAgoDate && <div style={{ fontSize: '0.63rem' }}>from {ind.sixMonthsAgoDate}</div>}
                    {/* Latest vintage, not first print — stated rather than
                        assumed, since a revised figure and an original one are
                        different numbers for the same month. */}
                    {ind.vintageDate && <div style={{ fontSize: '0.6rem', opacity: 0.75 }}>vintage {ind.vintageDate}</div>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <details style={{ marginTop: '0.9rem' }}>
        <summary style={{ cursor: 'pointer', fontSize: '0.72rem', color: GREY }}>
          What this is, and what it is not ({d.caveats.length})
        </summary>
        <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem', fontSize: '0.72rem', color: GREY, lineHeight: 1.65 }}>
          {d.caveats.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
      </details>
    </div>
  )
}
