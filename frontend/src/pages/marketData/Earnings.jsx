import { Fragment, useState, useEffect, useMemo } from 'react'

// ─── Sector & index earnings ─────────────────────────────────────────────────
//
// What the profit pool actually did last quarter, and why. Everything here
// describes REPORTED results — there is no score, no ranking implying which
// sector to buy, and no claim that any of it predicts a price. That is why none
// of it carries a track-record badge: it makes no forecast to have a record of.
//
// The page's job is to make its own headline distrustable. Every aggregate
// arrives with the coverage it was computed on, the companies excluded from it,
// and a decomposition of what drove it — because "+20%" is a retail number
// until you know whether it came from revenue, a tax rate or one company.

// A DIVERGING pair, not the conventional green/red: teal↔rose separates under
// deuteranopia at ΔE 8.4 where #34d399/#f87171 manages 6.5. Every bar is also
// direct-labelled with its signed value, so identity never rests on colour.
const POS = '#2dd4bf'
const NEG = '#fb7185'
const NEUTRAL = '#94a3b8'

// The five breadth states, ordered as a diverging sequence rather than five
// unrelated categories — they ARE ordered, from "grew" to "fell into loss".
const BREADTH = [
  { key: 'grew', label: 'grew', color: POS },
  { key: 'lossToProfit', label: 'loss → profit', color: '#5eead4' },
  { key: 'lossToLoss', label: 'still loss-making', color: '#64748b' },
  { key: 'shrank', label: 'shrank', color: NEG },
  { key: 'profitToLoss', label: 'profit → loss', color: '#f43f5e' },
]

const BRIDGE_LABEL = {
  revenue: 'Revenue', opm: 'Operating margin', otherIncome: 'Other income',
  interestDep: 'Interest & depreciation', tax: 'Tax rate',
  provisions: 'Provisions', preProvision: 'Pre-provision profit',
  residual: 'Interaction residual',
}

const pct = (v, dp = 1) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(dp)}%`)
const money = (v, unit) => {
  if (v == null) return '—'
  if (unit === 'INR_CR') return `₹${Math.round(v).toLocaleString('en-IN')} Cr`
  const abs = Math.abs(v)
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  return `$${Math.round(v).toLocaleString('en-US')}`
}
const toneOf = (v) => (v == null ? 'var(--text-secondary)' : v >= 0 ? POS : NEG)

/** Coverage, as two numbers — because one of them can pass while the other fails. */
function Coverage({ coverage }) {
  if (!coverage) return null
  const { reportedCount, constituents, countPct, poolPct, sufficient } = coverage
  return (
    <span
      title={`${reportedCount} of ${constituents} constituents have reported (${countPct?.toFixed(0)}%), and they are ${poolPct?.toFixed(0)}% of the year-ago profit pool. Both must clear their floor: a sector can be 70% reported by count and a fifth of it by profit.`}
      style={{
        fontSize: '0.68rem', whiteSpace: 'nowrap', cursor: 'help',
        color: sufficient ? 'var(--text-secondary)' : '#fcd34d',
      }}
    >
      {reportedCount}/{constituents} · {poolPct == null ? '—' : `${poolPct.toFixed(0)}%`} of pool
      {!sufficient && ' ⚠'}
    </span>
  )
}

/** Breadth as one stacked bar. Counts are printed, so colour is never the only cue. */
function BreadthBar({ breadth }) {
  const total = BREADTH.reduce((a, b) => a + (breadth?.[b.key] || 0), 0)
  if (!total) return <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>—</span>
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <div style={{ display: 'flex', height: '10px', width: '120px', borderRadius: '3px', overflow: 'hidden', gap: '2px' }}>
        {BREADTH.map(b => {
          const n = breadth[b.key] || 0
          if (!n) return null
          return (
            <div key={b.key} title={`${n} ${b.label}`}
              style={{ width: `${(n / total) * 100}%`, background: b.color, borderRadius: '2px' }} />
          )
        })}
      </div>
      <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
        {breadth.grew}↑ {breadth.shrank}↓
        {breadth.lossToProfit + breadth.profitToLoss + breadth.lossToLoss > 0 &&
          ` · ${breadth.lossToProfit + breadth.profitToLoss + breadth.lossToLoss} turned`}
      </span>
    </div>
  )
}

/**
 * The profit bridge, as a waterfall.
 *
 * The interaction residual is drawn like any other step rather than folded into
 * a neighbour — absorbing it would make one driver look larger than it was.
 */
function Bridge({ report }) {
  const steps = report.bridge || []
  if (!steps.length) return null
  const max = Math.max(...steps.map(s => Math.abs(s.delta)), 1)
  return (
    <section style={{ marginTop: '1.25rem' }}>
      <h4 style={{ margin: '0 0 0.15rem', fontSize: '0.85rem' }}>What moved the profit</h4>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '0.6rem' }}>
        {money(report.bridgeBase, report.unit)} → {money(report.bridgeClose, report.unit)}
        {report.bridgeNote && <> · <span style={{ color: '#fcd34d' }}>{report.bridgeNote}</span></>}
      </div>
      {steps.map(s => (
        <div key={s.step} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 110px', gap: '0.6rem', alignItems: 'center', marginBottom: '0.3rem' }}>
          <span style={{ fontSize: '0.72rem', color: s.step === 'residual' ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
            {BRIDGE_LABEL[s.step] || s.step}
          </span>
          <div style={{ display: 'flex', justifyContent: 'center', height: '14px' }}>
            <div style={{ width: '50%', display: 'flex', justifyContent: 'flex-end' }}>
              {s.delta < 0 && <div title={`${BRIDGE_LABEL[s.step] || s.step}: ${money(s.delta, report.unit)}`}
                style={{ width: `${(Math.abs(s.delta) / max) * 100}%`, background: NEG, borderRadius: '3px 0 0 3px', opacity: s.step === 'residual' ? 0.45 : 1 }} />}
            </div>
            <div style={{ width: '1px', background: 'var(--border)' }} />
            <div style={{ width: '50%' }}>
              {s.delta >= 0 && <div title={`${BRIDGE_LABEL[s.step] || s.step}: ${money(s.delta, report.unit)}`}
                style={{ width: `${(Math.abs(s.delta) / max) * 100}%`, height: '100%', background: POS, borderRadius: '0 3px 3px 0', opacity: s.step === 'residual' ? 0.45 : 1 }} />}
            </div>
          </div>
          <span style={{ fontSize: '0.72rem', textAlign: 'right', color: toneOf(s.delta), fontFamily: "'JetBrains Mono', monospace" }}>
            {money(s.delta, report.unit)}
          </span>
        </div>
      ))}
    </section>
  )
}

/** Who moved it. These sum to pool growth exactly — that is the point of showing them. */
function Contributions({ report }) {
  const rows = (report.contributions || []).slice(0, 8)
  if (!rows.length) return null
  const max = Math.max(...rows.map(r => Math.abs(r.delta)), 1)
  return (
    <section style={{ marginTop: '1.25rem' }}>
      <h4 style={{ margin: '0 0 0.15rem', fontSize: '0.85rem' }}>Who moved it</h4>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '0.6rem' }}>
        Every company's share of the change. These sum to the pool growth above — so a sector
        carried by one name looks like one name.
      </div>
      {rows.map(c => (
        <div key={c.symbol} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 150px', gap: '0.6rem', alignItems: 'center', marginBottom: '0.3rem' }}>
          <span style={{ fontSize: '0.72rem' }}>{c.symbol}</span>
          <div style={{ height: '12px', background: 'rgba(255,255,255,0.04)', borderRadius: '3px' }}>
            <div title={`${c.symbol}: ${money(c.delta, report.unit)}`}
              style={{ width: `${(Math.abs(c.delta) / max) * 100}%`, height: '100%', background: c.delta >= 0 ? POS : NEG, borderRadius: '3px' }} />
          </div>
          <span style={{ fontSize: '0.72rem', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: toneOf(c.delta) }}>
            {money(c.delta, report.unit)}
            {c.sharePct != null && <span style={{ color: 'var(--text-secondary)' }}> ({pct(c.sharePct)})</span>}
          </span>
        </div>
      ))}
    </section>
  )
}

/** Who has reported, and who has not. The partial season, made visible. */
function Tracker({ report }) {
  const rows = report.reporting || []
  const yet = rows.filter(r => !r.reported)
  return (
    <section style={{ marginTop: '1.25rem' }}>
      <h4 style={{ margin: '0 0 0.15rem', fontSize: '0.85rem' }}>Results season</h4>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '0.6rem' }}>
        {rows.length - yet.length} reported, {yet.length} still to come. Every figure above is
        computed only across companies present in BOTH periods.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
        {rows.map(r => (
          <span key={r.symbol}
            title={r.reported
              ? `Reported for the period ending ${r.periodEnd}${r.mergedInto ? ` · counted under ${r.mergedInto}` : ''}${r.backfilled ? ' · already published when first ingested, so no landing date is claimed' : ''}`
              : 'Not reported for this quarter yet'}
            style={{
              fontSize: '0.65rem', padding: '0.12rem 0.4rem', borderRadius: '4px', cursor: 'help',
              border: `1px solid ${r.reported ? 'rgba(45,212,191,0.3)' : 'var(--border)'}`,
              background: r.reported ? 'rgba(45,212,191,0.08)' : 'transparent',
              color: r.reported ? 'var(--text-primary)' : 'var(--text-secondary)',
              opacity: r.mergedInto ? 0.55 : 1,
            }}>
            {r.symbol}{r.mergedInto ? ' ⇢' : ''}
          </span>
        ))}
      </div>
      {(report.excluded || []).length > 0 && (
        <div style={{ marginTop: '0.7rem', fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
          <strong style={{ color: '#fcd34d' }}>Excluded from the comparison:</strong>{' '}
          {report.excluded.map(e => `${e.symbol} (${e.reason})`).join(', ')} — dropped rather than
          computed, because each would have produced a number that means nothing.
        </div>
      )}
    </section>
  )
}

/**
 * One scope's detail, shared by this page and the sector drill-down's Earnings
 * tab — so the two cannot drift into showing different decompositions of the
 * same quarter.
 */
export function ScopeDetail({ market, scope, quarter }) {
  const [report, setReport] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let on = true
    const base = market === 'US' ? '/api/us/fundamentals' : '/api/fundamentals'
    fetch(`${base}/sector/${encodeURIComponent(scope)}?quarter=${quarter}`)
      .then(r => r.json())
      .then(j => { if (!on) return; j.error ? setError(j.error) : setReport(j) })
      .catch(e => on && setError(e.message))
    return () => { on = false }
  }, [market, scope, quarter])

  if (error) return <div style={{ padding: '1rem', color: 'var(--danger)', fontSize: '0.8rem' }}>{error}</div>
  if (!report) return <div style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Loading…</div>

  return (
    <div style={{ padding: '1rem 1.25rem', background: 'rgba(255,255,255,0.02)', borderRadius: '8px' }}>
      <div style={{ fontSize: '0.8rem', marginBottom: '0.3rem' }}>{report.verdict}</div>
      {report.weightNote && (
        <div style={{ fontSize: '0.68rem', color: '#fcd34d', marginBottom: '0.3rem' }}>{report.weightNote}</div>
      )}
      {report.qoq?.caveat && (
        <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
          Sequential: {pct(report.qoq.poolGrowthPct)} — {report.qoq.caveat}
        </div>
      )}
      <Bridge report={report} />
      <Contributions report={report} />
      <Tracker report={report} />
    </div>
  )
}

const COLUMNS = [
  { key: 'scope', label: 'Sector', align: 'left' },
  { key: 'pool', label: 'Profit pool YoY', hint: 'Σ net profit this quarter ÷ Σ the same quarter a year ago, across companies that reported BOTH.' },
  { key: 'weighted', label: 'Index-weighted', hint: 'Σ(cap × EPS) this quarter ÷ the same a year ago, one as-of weight vector on both sides. Total market cap, not free-float.' },
  { key: 'median', label: 'Median company', hint: 'Median per-company net-profit growth. When this and the pool diverge, one large company is carrying the sector.' },
  { key: 'breadth', label: 'Breadth', align: 'left' },
  { key: 'coverage', label: 'Reported', align: 'left' },
]

export default function Earnings() {
  const [market, setMarket] = useState('IN')
  const [quarter, setQuarter] = useState(null)
  const [quarters, setQuarters] = useState([])
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(null)
  const [sort, setSort] = useState({ key: 'pool', dir: 'desc' })

  const base = market === 'US' ? '/api/us/fundamentals' : '/api/fundamentals'

  useEffect(() => {
    let on = true
    setLoading(true); setError(null); setData(null); setOpen(null)
    fetch(`${base}/sectors${quarter ? `?quarter=${quarter}` : ''}`)
      .then(r => r.json())
      .then(j => {
        if (!on) return
        if (j.error) { setError(j.error); return }
        setData(j); setQuarters(j.quarters || []); setQuarter(j.quarter)
      })
      .catch(e => on && setError(e.message))
      .finally(() => on && setLoading(false))
    return () => { on = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, quarter])

  const rows = useMemo(() => {
    const list = [...(data?.scopes || [])]
    const val = (r) => ({
      scope: r.scope, pool: r.yoy?.poolGrowthPct, weighted: r.yoy?.weightedGrowthPct,
      median: r.yoy?.medianGrowthPct, coverage: r.coverage?.poolPct, breadth: r.breadth?.grew,
    }[sort.key])
    return list.sort((a, b) => {
      const av = val(a), bv = val(b)
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [data, sort])

  const onMarket = (m) => { setMarket(m); setQuarter(null) }

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1400px', margin: '0 auto' }}>
      <div style={{ marginBottom: '1rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem' }}>Earnings</h1>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          What each sector's profit pool did, and what moved it
        </span>
      </div>

      <div className="glass-panel" style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap', padding: '0.85rem 1.1rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          {['IN', 'US'].map(m => (
            <button key={m} onClick={() => onMarket(m)} style={{
              padding: '0.3rem 0.8rem', borderRadius: '4px', fontSize: '0.78rem', cursor: 'pointer',
              border: `1px solid ${market === m ? 'var(--accent)' : 'var(--border)'}`,
              background: market === m ? 'rgba(56,189,248,0.12)' : 'transparent',
              color: market === m ? 'var(--accent)' : 'var(--text-secondary)',
              fontWeight: market === m ? 700 : 400,
            }}>{m === 'IN' ? 'India' : 'US'}</button>
          ))}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          Quarter
          <select value={quarter || ''} onChange={e => setQuarter(e.target.value)}
            style={{ padding: '0.3rem 0.6rem', borderRadius: '4px', background: 'var(--bg-dark)', color: 'var(--text-primary)', border: '1px solid var(--border)', fontSize: '0.78rem' }}>
            {quarters.map(q => <option key={q} value={q}>{q}</option>)}
          </select>
        </label>
        {data?.weightsAsOf && (
          <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
            Weights as of {data.weightsAsOf}
          </span>
        )}
      </div>

      {loading && <div className="loader" style={{ margin: '2rem auto' }} />}
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>}

      {data && !loading && (
        <section className="glass-panel" style={{ padding: '1rem 1.25rem' }}>
          <table className="interactive-table" style={{ width: '100%', fontSize: '0.8rem' }}>
            <thead>
              <tr>
                {COLUMNS.map(c => (
                  <th key={c.key} title={c.hint}
                    onClick={() => setSort(s => ({ key: c.key, dir: s.key === c.key && s.dir === 'desc' ? 'asc' : 'desc' }))}
                    style={{ textAlign: c.align || 'right', cursor: 'pointer', padding: '0.4rem 0.5rem', color: sort.key === c.key ? 'var(--accent)' : 'var(--text-secondary)', fontSize: '0.7rem', whiteSpace: 'nowrap' }}>
                    {c.label}{sort.key === c.key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <Fragment key={r.scope}>
                  <tr onClick={() => setOpen(open === r.scope ? null : r.scope)}
                    style={{ cursor: 'pointer', opacity: r.coverage?.sufficient ? 1 : 0.6 }}>
                    <td style={{ padding: '0.45rem 0.5rem' }}>
                      {open === r.scope ? '▾ ' : '▸ '}{r.scope.replace(/^NSE:/, '')}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: toneOf(r.yoy?.poolGrowthPct) }}
                      title={r.yoy?.poolGrowthPct == null ? `No percentage: the year-ago base is negative or near zero. Absolute change ${money(r.yoy?.poolDeltaAbs, r.unit)}.` : undefined}>
                      {r.yoy?.poolGrowthPct == null ? money(r.yoy?.poolDeltaAbs, r.unit) : pct(r.yoy.poolGrowthPct)}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: toneOf(r.yoy?.weightedGrowthPct) }}>
                      {pct(r.yoy?.weightedGrowthPct)}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: toneOf(r.yoy?.medianGrowthPct) }}>
                      {pct(r.yoy?.medianGrowthPct)}
                    </td>
                    <td style={{ padding: '0.45rem 0.5rem' }}><BreadthBar breadth={r.breadth} /></td>
                    <td style={{ padding: '0.45rem 0.5rem' }}><Coverage coverage={r.coverage} /></td>
                  </tr>
                  {open === r.scope && (
                    <tr>
                      <td colSpan={COLUMNS.length} style={{ padding: '0.25rem 0.5rem 1rem' }}>
                        {/* Keyed so a change of scope or quarter REMOUNTS this
                            rather than briefly showing the previous sector's
                            numbers under the new sector's heading. */}
                        <ScopeDetail key={`${market}:${r.scope}:${quarter}`}
                          market={market} scope={r.scope} quarter={quarter} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.9rem', flexWrap: 'wrap', fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
            {BREADTH.map(b => (
              <span key={b.key}><span style={{ color: b.color }}>▮</span> {b.label}</span>
            ))}
          </div>
        </section>
      )}

      {/* On the page, not in a tooltip: these are the reasons a number here can
          be misread, and they belong where the number is. */}
      {data && !loading && (
        <section className="glass-panel" style={{ padding: '1rem 1.25rem', marginTop: '1rem', fontSize: '0.72rem', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <strong style={{ color: 'var(--text-primary)' }}>How to read this</strong>
          <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem' }}>
            <li><strong>Same-store.</strong> Every figure compares only companies that reported both
              periods. A 60%-reported season measured against a full year-ago one would show a
              collapse every quarter.</li>
            <li><strong>Coverage is two numbers.</strong> 7 of 10 companies can be a fifth of the
              profit pool, so both the count and the pool share must clear their floor before a
              sector is called at all. Rows that don't are dimmed.</li>
            <li><strong>Pool vs median.</strong> The pool is the sector's earnings; the median is the
              typical company. When they disagree, one large company is the sector.</li>
            <li><strong>Sign changes are not percentages.</strong> A company going from loss to profit
              is counted in breadth, never divided into a growth rate.</li>
            <li><strong>Survivorship.</strong> Constituents are today's index members, so companies
              dropped along the way never appear and past quarters are flattered. Membership is now
              being recorded daily, which fixes this going forward but not backwards.</li>
            <li><strong>{data.note}</strong></li>
          </ul>
        </section>
      )}
    </div>
  )
}
