import { useEffect, useState } from 'react'
import {
  REGIME_WORD, POLICY_WORD, COMPONENT_LABEL, SCORE_TOOLTIP,
  directionWord, confidenceConstraint, signalTriad, countdown,
  explain, explainShort, componentInterpretation, whatWouldChangeByDirection,
  displayContributions,
  freshnessStatus, sixMonthRead, interpretIndicator, contextReason,
  shortTitle, reportMonth, signed,
} from '../lib/macroRead.js'

// ─── Macro Decision Monitor ──────────────────────────────────────────────────
//
// Six months of official US macro data as five weighted components and one
// regime read. Terminal style: dense, tabular numerals, no decoration.
//
// The layout answers five questions in order, because a reader who has to
// assemble the answer from bars will assemble it wrong:
//
//   1. what regime          — headline, largest type on the screen
//   2. why                  — derived paragraph, immediately under it
//   3. what could move it   — next catalyst, same row as the regime
//   4. what would change it — collapsible, computed against the thresholds
//   5. what agrees/disagrees— component bars, then the indicator detail
//
// Every word of it is DERIVED (see lib/macroRead.js). The one time a summary of
// this panel was written by hand it named the wrong offset.
//
// Three rules the styling follows:
//   · Direction is carried by icon AND text AND colour, never colour alone.
//   · Cooling reads green because this panel is about INFLATION pressure, not
//     about markets — falling price pressure is the "good" direction here.
//   · Nothing claims a central bank will do anything. "Hold-compatible" is a
//     property of the data, and the qualifier next to it says so permanently.

const GREEN = 'var(--success)', RED = 'var(--danger)', GREY = 'var(--text-secondary)'
const AMBER = '#fbbf24'

const REGIME_TONE = { cooling: GREEN, neutral: AMBER, reaccelerating: RED, unknown: GREY }
const TONE_COLOR = { ok: GREEN, warn: AMBER, bad: RED, muted: GREY }

// ▲ pressure, ▼ cooling, ◆ risk, ○ unavailable — so the direction survives
// greyscale, colour-blindness and a screen reader.
const MARK = { up: '▲', down: '▼', flat: '◆', none: '○' }
const markFor = (v) => (v == null ? MARK.none : v > 0.005 ? MARK.up : v < -0.005 ? MARK.down : MARK.flat)
const toneFor = (v) => (v == null ? GREY : v > 0.005 ? RED : v < -0.005 ? GREEN : AMBER)

// One precision for the score, the triad and the contribution column. They are
// reconciled against each other, so they must be rendered at the same scale.
const SCORE_DP = 3

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const longDate = (iso) => {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return `${MONTH[+m - 1]} ${+d}, ${y}`
}

function Section({ title, count, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.7rem', marginTop: '0.7rem' }}>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: GREY,
          fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600,
          display: 'flex', alignItems: 'center', gap: '0.4rem',
        }}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        {title}{count != null && ` (${count})`}
      </button>
      {open && <div style={{ marginTop: '0.6rem' }}>{children}</div>}
    </div>
  )
}

/** Score on its scale, with the neutral band drawn so −0.06 reads as a position. */
function ScoreScale({ score, coolingMax, reaccelMin }) {
  const pos = Math.max(0, Math.min(100, ((score + 1) / 2) * 100))
  const bandL = ((coolingMax + 1) / 2) * 100
  const bandR = ((reaccelMin + 1) / 2) * 100
  return (
    <div style={{ marginTop: '0.35rem' }}>
      <div style={{ position: 'relative', height: 10, background: 'var(--border)', borderRadius: 2 }}>
        <div style={{ position: 'absolute', left: `${bandL}%`, width: `${bandR - bandL}%`, top: 0, bottom: 0, background: `${AMBER}33` }} />
        <div style={{ position: 'absolute', left: `calc(${pos}% - 1px)`, top: -2, bottom: -2, width: 2, background: 'var(--text-primary)' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: GREY, marginTop: '0.2rem' }}>
        <span>Cooling</span><span>Neutral range</span><span>Re-accelerating</span>
      </div>
    </div>
  )
}

/**
 * Contribution as a bar growing from the centre: cooling left, pressure right.
 *
 * Both halves are flex containers and the fill carries an explicit height.
 * That is not belt-and-braces — the first version made only the LEFT half a
 * flex container, so its child was stretched to the track height by
 * align-items: stretch, while the right half was a plain block whose child had
 * a width and no height and therefore collapsed to nothing. Every positive
 * (red) contribution rendered as an empty track: inflation at +0.14 and oil at
 * +0.05 were invisible, and the panel looked as though only cooling forces
 * existed — the exact opposite of the reading it was reporting.
 */
function ContributionBar({ contribution }) {
  const pct = contribution == null ? 0 : Math.min(100, (Math.abs(contribution) / 0.5) * 100)
  const positive = (contribution || 0) >= 0
  const fill = (color) => ({ width: `${pct}%`, height: '100%', background: color })
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', height: 8, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ width: '50%', display: 'flex', justifyContent: 'flex-end' }}>
        {!positive && <div style={fill(GREEN)} />}
      </div>
      <div style={{ width: '50%', display: 'flex', justifyContent: 'flex-start' }}>
        {positive && <div style={fill(RED)} />}
      </div>
    </div>
  )
}

export default function MacroDecisionMonitor() {
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  const [loading, setLoading] = useState(true)
  const [openRow, setOpenRow] = useState(null)
  const [detailOpen, setDetailOpen] = useState(false)

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

  const regimeKey = d.composite.regime || 'unknown'
  const tone = REGIME_TONE[regimeKey] || GREY
  const triad = signalTriad(d)
  const conf = confidenceConstraint(d.confidence)
  const changeGroups = whatWouldChangeByDirection(d)
  // Rounded so the column adds up to the headline — see distributeRounding.
  // Same precision as the score above it, or the two cannot agree.
  const contributions = displayContributions(d, SCORE_DP)
  const next = d.releases?.next
  const scored = d.indicators.filter(i => i.scored)
  const context = d.indicators.filter(i => !i.scored)
  const band = d.thresholds?.regime || { coolingMax: -0.25, reaccelMin: 0.25 }

  const label = { fontSize: '0.62rem', color: GREY, textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600 }
  const cell = { padding: '0.5rem 0.6rem', fontSize: '0.8rem', fontVariantNumeric: 'tabular-nums' }
  const th = { ...cell, ...label, textAlign: 'left', padding: '0.4rem 0.6rem' }

  return (
    <div className="glass-panel" style={{ padding: '1rem', marginBottom: '1.25rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.5rem' }}>
        <h2 style={{ margin: 0, fontSize: '1rem', letterSpacing: '0.02em' }}>Macro Decision Monitor</h2>
        <span style={{ fontSize: '0.66rem', color: GREY }}>
          US · six-month window · {d.dataPath === 'database' ? 'stored vintages' : 'live from FRED'}
        </span>
      </div>

      {/* ─── PRIMARY: regime, interpretation, catalyst ─────────────────────── */}
      <div
        aria-live="polite"
        style={{
          margin: '0.85rem 0', padding: '0.9rem 1rem', borderRadius: 8,
          border: `1px solid ${tone}55`, background: `${tone}0f`,
          display: 'grid', gap: '1.25rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
        }}
      >
        <div>
          <div style={label}>Regime</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: tone, lineHeight: 1.2 }}>
            {REGIME_WORD[regimeKey] || 'Unknown'}
          </div>
          <div style={{ fontSize: '0.7rem', color: GREY }}>Based on the last six months of data</div>
        </div>

        <div>
          <div style={label}>Policy interpretation</div>
          <div style={{ fontSize: '1.15rem', fontWeight: 700, color: tone, lineHeight: 1.3 }}>
            {POLICY_WORD[d.composite.bias] || '—'}
          </div>
          {/* Permanent, not a tooltip: the single most misreadable line here. */}
          <div style={{ fontSize: '0.68rem', color: GREY }}>
            Macro score: {signed(d.composite.score, 3)} · not a Fed forecast
          </div>
        </div>

        <div>
          {/* What just landed, so the panel is not still pointing at a release
              that published hours ago — the state it used to sit in all day. */}
          {d.releases?.latest && (
            <div style={{ marginBottom: '0.5rem' }}>
              <div style={label}>Just released</div>
              <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>{shortTitle(d.releases.latest.title)}</div>
              <div style={{ fontSize: '0.68rem', color: GREEN }}>
                published today{reportMonth(d.releases.latest.detail) ? ` · ${reportMonth(d.releases.latest.detail)}` : ''} · already in the figures below
              </div>
            </div>
          )}
          <div style={label}>Next catalyst</div>
          {next ? (
            <>
              <div style={{ fontSize: '1.05rem', fontWeight: 700, lineHeight: 1.3 }}>{shortTitle(next.title)}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-primary)' }}>
                {longDate(next.date)} · <span style={{ color: AMBER }}>{countdown(next.daysAway)}</span>
              </div>
              {reportMonth(next.detail) && (
                <div style={{ fontSize: '0.66rem', color: GREY, marginTop: '0.1rem' }}>
                  Report month: {reportMonth(next.detail)}
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: '0.75rem', color: AMBER }}>
              Release calendar unavailable — not an all-clear.
            </div>
          )}
        </div>
      </div>

      {/* One sentence carries the screen; the fuller reading is one click away.
          Both derived, so they can never disagree with each other. */}
      <div style={{ margin: '0 0 0.85rem', maxWidth: '76ch' }}>
        <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.6 }}>{explainShort(d)}</p>
        <button
          onClick={() => setDetailOpen(!detailOpen)}
          aria-expanded={detailOpen}
          style={{ background: 'none', border: 'none', padding: '0.25rem 0 0', cursor: 'pointer', color: GREY, fontSize: '0.72rem' }}
        >
          <span aria-hidden="true">{detailOpen ? '▾' : '▸'}</span> {detailOpen ? 'Less detail' : 'More detail'}
        </button>
        {detailOpen && (
          <p style={{ margin: '0.35rem 0 0', fontSize: '0.8rem', lineHeight: 1.65, color: 'var(--text-secondary)' }}>
            {explain(d)}
          </p>
        )}
      </div>

      {/* Signal status triad. */}
      <div style={{ display: 'grid', gap: '0.3rem', marginBottom: '0.9rem' }}>
        {[
          ['Upside pressure', triad.pressure, triad.pressure?.value],
          ['Cooling offset', triad.offset, triad.offset?.value],
        ].map(([name, item, value]) => (
          <div key={name} style={{ display: 'grid', gridTemplateColumns: '1.2rem 8.5rem 1fr auto', gap: '0.5rem', alignItems: 'baseline', fontSize: '0.78rem' }}>
            <span aria-hidden="true" style={{ color: toneFor(value) }}>{markFor(value)}</span>
            <span style={{ color: GREY }}>{name}</span>
            <span style={{ fontWeight: 600 }}>{item ? item.label : 'none'}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: toneFor(value) }}>
              {value == null ? '—' : signed(value, SCORE_DP)}
            </span>
          </div>
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: '1.2rem 8.5rem 1fr', gap: '0.5rem', alignItems: 'baseline', fontSize: '0.78rem' }}>
          <span aria-hidden="true" style={{ color: AMBER }}>{MARK.flat}</span>
          <span style={{ color: GREY }}>Next catalyst</span>
          <span style={{ fontWeight: 600 }}>
            {triad.risk ? `${shortTitle(triad.risk.title)} · ${countdown(triad.risk.daysAway)}` : 'no scheduled catalyst'}
          </span>
        </div>
      </div>

      {/* ─── SECONDARY: score and confidence ──────────────────────────────── */}
      <div style={{ display: 'grid', gap: '1.25rem', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', marginBottom: '0.4rem' }}>
        <div>
          <div style={label} title={SCORE_TOOLTIP}>Macro score</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem' }}>
            <span
              style={{ fontSize: '1.2rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums', cursor: 'help' }}
              tabIndex={0}
              title={SCORE_TOOLTIP}
            >{signed(d.composite.score, 3)}</span>
            <span style={{ fontSize: '0.82rem', color: tone }}>{directionWord(d.composite.score)}</span>
          </div>
          <ScoreScale score={d.composite.score ?? 0} coolingMax={band.coolingMax} reaccelMin={band.reaccelMin} />
        </div>
        <div>
          <div style={label}>Confidence</div>
          <div style={{ fontSize: '1.2rem', fontWeight: 700, textTransform: 'capitalize', color: d.confidence.level === 'high' ? GREEN : d.confidence.level === 'medium' ? AMBER : RED }}>
            {d.confidence.level}
          </div>
          {/* Name the binding constraint rather than printing three percentages. */}
          <div style={{ fontSize: '0.75rem', color: GREY, lineHeight: 1.5 }}>{conf?.text || '—'}</div>
          {/* The three numbers behind that sentence, small and after it — the
              words do the work, the figures are for anyone checking. */}
          <div style={{ display: 'flex', gap: '0.9rem', fontSize: '0.63rem', color: GREY, marginTop: '0.25rem', fontVariantNumeric: 'tabular-nums' }}>
            <span>Freshness {Math.round(d.confidence.freshness * 100)}%</span>
            <span>Agreement {Math.round(d.confidence.agreement * 100)}%</span>
            <span>Coverage {Math.round(d.composite.coverage * 100)}%</span>
          </div>
        </div>
      </div>

      {/* ─── SECONDARY: component contributions ───────────────────────────── */}
      <div style={{ marginTop: '0.9rem' }}>
        <div style={{ ...label, marginBottom: '0.45rem' }}>Component contributions</div>
        <div style={{ display: 'grid', gap: '0.55rem' }}>
          {contributions.map(c => {
            const sig = d.signals[c.key] || {}
            const partial = sig.inputsTotal > 0 && sig.inputsUsed < sig.inputsTotal
            return (
              <div key={c.key}>
                <div style={{ display: 'grid', gridTemplateColumns: '1.1rem minmax(120px, 1.5fr) 2fr auto', gap: '0.5rem', alignItems: 'center' }}>
                  <span aria-hidden="true" style={{ color: toneFor(c.contribution), fontSize: '0.72rem' }}>{markFor(c.contribution)}</span>
                  <span style={{ fontSize: '0.78rem' }}>
                    {COMPONENT_LABEL[c.key] || c.key}{' '}
                    <span style={{ color: GREY }}>{Math.round(c.weight * 100)}%</span>
                  </span>
                  <div
                    role="img"
                    aria-label={`${COMPONENT_LABEL[c.key] || c.key}, weight ${Math.round(c.weight * 100)} percent, contributing ${c.display == null ? 'nothing' : signed(c.display, SCORE_DP)} to the composite`}
                  >
                    <ContributionBar contribution={c.contribution} />
                  </div>
                  <span style={{ fontSize: '0.76rem', fontVariantNumeric: 'tabular-nums', color: toneFor(c.contribution), minWidth: 54, textAlign: 'right' }}>
                    {c.display == null ? 'n/a' : signed(c.display, SCORE_DP)}
                  </span>
                </div>
                <div style={{ paddingLeft: '1.6rem', marginTop: '0.12rem' }}>
                  <div style={{ fontSize: '0.64rem', color: partial ? AMBER : GREY, fontFamily: 'ui-monospace, monospace' }}>
                    {sig.usedSeries?.length ? sig.usedSeries.join(' + ') : (sig.reason || 'no inputs')}
                    {sig.inputsTotal > 0 && ` · ${sig.inputsUsed} of ${sig.inputsTotal} series`}
                    {partial && sig.excluded?.length ? ` · ${sig.excluded.join(', ')} excluded` : ''}
                  </div>
                  {/* Never a bar and a number alone: every contribution states
                      the reading that produced it, derived from the same
                      values, so the two cannot drift apart. */}
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: '0.1rem', maxWidth: '72ch' }}>
                    {componentInterpretation(c.key, d)}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ─── SECONDARY: what would change this ────────────────────────────── */}
      {changeGroups.length > 0 && (
        <Section title="What would change this signal">
          {/* Grouped by which way it would move, because a flat list makes the
              reader work out the direction of every line for themselves. */}
          <div style={{ display: 'grid', gap: '0.8rem' }}>
            {changeGroups.map(g => (
              <div key={g.direction}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem', marginBottom: '0.2rem' }}>
                  <span aria-hidden="true" style={{ color: g.direction === 'hotter' ? RED : g.direction === 'cooler' ? GREEN : AMBER, fontSize: '0.7rem' }}>
                    {g.direction === 'hotter' ? MARK.up : g.direction === 'cooler' ? MARK.down : MARK.flat}
                  </span>
                  <span style={{ fontSize: '0.72rem', fontWeight: 600, color: g.direction === 'hotter' ? RED : g.direction === 'cooler' ? GREEN : AMBER }}>
                    {g.heading}
                  </span>
                </div>
                <ul style={{ margin: 0, paddingLeft: '1.5rem', fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.65 }}>
                  {g.items.map((it, i) => <li key={i}>{it}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ─── A SEPARATE gauge, not part of the composite ──────────────────── */}
      {d.financial?.score != null && (
        <Section title="Financial conditions">
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' }}>
              <span aria-hidden="true" style={{ color: toneFor(d.financial.score), fontSize: '0.75rem' }}>
                {markFor(d.financial.score)}
              </span>
              <span style={{ fontSize: '1.05rem', fontWeight: 700, textTransform: 'capitalize', color: toneFor(d.financial.score) }}>
                {d.financial.state}
              </span>
              <span style={{ fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums', color: GREY }}>
                {signed(d.financial.score, 2)} · {d.financial.inputsUsed} of {d.financial.inputsTotal} series
              </span>
            </div>
            <p style={{ margin: 0, fontSize: '0.78rem', lineHeight: 1.6, color: 'var(--text-secondary)', maxWidth: '76ch' }}>
              {d.financial.summary}
            </p>
            <div style={{ display: 'grid', gap: '0.25rem', fontSize: '0.72rem', color: GREY, fontVariantNumeric: 'tabular-nums' }}>
              {Object.entries(d.financial.components).filter(([, v]) => v).map(([k, v]) => (
                <div key={k} style={{ display: 'flex', gap: '0.5rem' }}>
                  <span style={{ fontFamily: 'ui-monospace, monospace', minWidth: 130 }}>{v.seriesId}</span>
                  <span style={{ minWidth: 70, textAlign: 'right' }}>{v.value.toFixed(2)}</span>
                  <span style={{ color: v.scored === false ? GREY : toneFor(v.score) }}>
                    {v.scored === false ? 'context only' : signed(v.score, 2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Section>
      )}

      {/* ─── TERTIARY: indicator detail ───────────────────────────────────── */}
      <Section title="Indicator detail" count={d.indicators.length}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Indicator</th>
                <th style={{ ...th, textAlign: 'right' }}>Latest</th>
                <th style={{ ...th, textAlign: 'right' }}>Six-month</th>
                <th style={th}>Reading</th>
              </tr>
            </thead>
            <tbody>
              {[...scored, ...context].map(ind => {
                const six = sixMonthRead(ind)
                const fresh = freshnessStatus(ind, d.thresholds?.staleness?.maxForScoring ?? 1)
                const reason = contextReason(ind)
                const open = openRow === ind.seriesId
                return (
                  <tr key={ind.seriesId} style={{ borderTop: '1px solid var(--border)', opacity: ind.scored ? 1 : 0.72 }}>
                    <td style={cell}>
                      <button
                        onClick={() => setOpenRow(open ? null : ind.seriesId)}
                        aria-expanded={open}
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-primary)', fontSize: '0.8rem', textAlign: 'left' }}
                      >
                        {ind.label} <span aria-hidden="true" style={{ color: GREY }}>{open ? '▾' : '▸'}</span>
                      </button>
                      <div style={{ fontSize: '0.63rem', color: TONE_COLOR[fresh.tone] }}>
                        <span style={{ fontFamily: 'ui-monospace, monospace', color: GREY }}>{ind.seriesId}</span> · {fresh.label}
                      </div>
                      {/* This panel is part data board, part model. The Latest
                          column is what the agency published; the Six-month
                          column is computed here. Saying which is which stops a
                          derived figure being read as an official print. */}
                      <div style={{ fontSize: '0.6rem', color: GREY, marginTop: '0.1rem' }}>
                        <span title="Published by the statistical agency, stored unchanged">Latest: official release</span>
                        {' · '}
                        <span title="Computed by this dashboard from the official levels">Six-month: derived here</span>
                        {!ind.scored && ' · context only'}
                      </div>
                      {open && (
                        <div style={{ fontSize: '0.67rem', color: GREY, marginTop: '0.35rem', lineHeight: 1.6, maxWidth: '46ch' }}>
                          <div>Source: {ind.source} · unit {ind.unit}</div>
                          <div>Observation month: {ind.latestDate || '—'}{ind.sixMonthsAgoDate && ` · compared with ${ind.sixMonthsAgoDate}`}</div>
                          {ind.vintageDate && (
                            <div>{d.vintagesAvailable ? 'Source vintage' : 'First recorded here'}: {longDate(ind.vintageDate)}</div>
                          )}
                          {/* The transforms the press actually quotes. The panel
                              scores a 6-month annualized rate, which no CPI
                              headline uses — so a reader checking "core CPI rose
                              0.2%" against 2.42% annualized concludes the
                              dashboard is wrong. Both are right and they are
                              different quantities; showing all three makes that
                              checkable instead of confusing. */}
                          {(Number.isFinite(ind.momPct) || Number.isFinite(ind.yoyPct)) && (
                            <div>
                              As the press quotes it:
                              {Number.isFinite(ind.momPct) && ` ${signed(ind.momPct)}% month-over-month`}
                              {Number.isFinite(ind.annualized1m) && ` (${signed(ind.annualized1m)}% annualized)`}
                              {Number.isFinite(ind.momPct) && Number.isFinite(ind.yoyPct) && ' ·'}
                              {Number.isFinite(ind.yoyPct) && ` ${signed(ind.yoyPct)}% year-over-year`}
                              {' — seasonally adjusted. Every rate here is annualized where marked, so they can be compared directly.'}
                            </div>
                          )}
                          {ind.monthlyChanges?.length > 0 && (
                            <div>Monthly: {ind.monthlyChanges.map(c => `${MONTH[+c.date.slice(5, 7) - 1]} ${c.change >= 0 ? '+' : ''}${Math.round(c.change)}k`).join(' · ')}</div>
                          )}
                          {ind.live && (
                            <div style={{ marginTop: '0.25rem' }}>
                              Live {ind.live.symbol} ({ind.live.instrument}) {ind.live.price.toFixed(2)}, {ind.live.delayMin ?? 15}-min delayed
                              {Number.isFinite(ind.live.rocPct) && ` — ${ind.live.rocPct >= 0 ? '+' : ''}${ind.live.rocPct.toFixed(2)}% against the same six-month base`}.
                              {' '}{ind.live.wouldChangeScore
                                ? 'Using it WOULD move this component.'
                                : 'Using it would not change this component, so the settled series being a few days behind costs nothing here.'}
                            </div>
                          )}
                          {reason && <div style={{ marginTop: '0.25rem' }}>{reason}</div>}
                          {ind.note && <div style={{ marginTop: '0.25rem' }}>{ind.note}</div>}
                        </div>
                      )}
                    </td>
                    <td style={{ ...cell, textAlign: 'right' }}>
                      {ind.latest == null ? '—' : ind.transform === 'count' ? Math.round(ind.latest).toLocaleString() : ind.latest.toFixed(2)}
                      {/* Live quote beside the settled figure. Deliberately a
                          different instrument and labelled as one — see
                          liveOil() in backend/macro/monitor.js. */}
                      {ind.live && (
                        <div style={{ fontSize: '0.63rem', color: AMBER }}
                             title={`${ind.live.instrument} (${ind.live.symbol}), ${ind.live.delayMin ?? 15}-min delayed. Shown for freshness; the six-month score uses the settled spot series.`}>
                          live {ind.live.price.toFixed(2)}
                        </div>
                      )}
                    </td>
                    <td style={{ ...cell, textAlign: 'right' }}>
                      <div style={{ fontWeight: 600 }}>{six.value}</div>
                      <div style={{ fontSize: '0.62rem', color: GREY }}>{six.label}</div>
                    </td>
                    <td style={{ ...cell, fontSize: '0.74rem', color: ind.scored ? 'var(--text-secondary)' : GREY }}>
                      {ind.scored ? interpretIndicator(ind, d.thresholds) : 'Context only · not scored'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="What this is, and what it is not" count={d.caveats.length}>
        <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.72rem', color: GREY, lineHeight: 1.7 }}>
          {d.caveats.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
      </Section>
    </div>
  )
}
