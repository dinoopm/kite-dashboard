import { useEffect, useMemo, useState } from 'react'
import { fmtDate } from '../lib/formatDate'
import { mergeScorecards, summarize, sortRows, evidenceLabel, STATUS_ORDER, STATUS_META } from '../lib/trackRecord'

// ─── Track record: every claim the app makes, and whether it has been checked ─
//
// Each signal already carries a small badge where it is shown. That answers
// "does THIS one work?" and leaves "which parts of the app can I trust?"
// unanswerable without visiting every page. This is the one place that lists
// them all, sorted by how much is actually known.
//
// It measures nothing itself. Three scorecards are fetched and merged
// (lib/trackRecord), and each row's state is read off the headline its scorer
// already produced — so this page cannot disagree with a badge.

const GREY = 'var(--text-secondary)'
const SOURCES = [
  { key: 'india', url: '/api/signals/scorecard', name: 'Indian signals' },
  { key: 'usPicks', url: '/api/us/stock-picks/scorecard', name: 'US quant picks' },
  { key: 'rrg', url: '/api/rrg/scorecard', name: 'RRG rotation' },
]

// Same meanings as the badges (components/SignalScore): green only ever means
// "beat the benchmark"; a warning that worked is amber, never green.
const TONE = {
  positive: '#34d399', negative: '#fca5a5', held: '#fbbf24', refuted: GREY,
  thin: GREY, 'no-data': GREY, 'no-benchmark': GREY, unscoreable: '#fcd34d',
}
const STATUS_ACCENT = { measured: '#34d399', 'no-edge': '#94a3b8', thin: '#64748b', blocked: '#fcd34d' }
const MARKETS = [{ key: 'all', label: 'All' }, { key: 'IN', label: 'India' }, { key: 'US', label: 'US' }]

const fmtPct = (v) => (v == null ? '–' : `${v > 0 ? '+' : ''}${v}%`)

function Horizons({ row }) {
  const hs = row.horizons.filter(h => h.n || h.unresolved)
  if (!hs.length) return null
  const cell = { padding: '0.3rem 0.6rem', fontSize: '0.78rem', textAlign: 'right', whiteSpace: 'nowrap' }
  const th = { ...cell, color: GREY, fontWeight: 600, fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.4px' }
  return (
    <div style={{ overflowX: 'auto', marginTop: '0.6rem' }}>
      <table style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: 'left' }}>Horizon</th>
            <th style={th}>Resolved</th>
            <th style={th}>Median vs {row.benchmark}</th>
            <th style={th}>Beat {row.benchmark}</th>
            <th style={th}>Median return</th>
            <th style={th}>Unresolved</th>
          </tr>
        </thead>
        <tbody>
          {hs.map(h => (
            <tr key={h.horizon} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <td style={{ ...cell, textAlign: 'left', color: GREY }}>{h.horizon}</td>
              <td style={cell}>{h.n}</td>
              <td style={{ ...cell, fontWeight: 600 }}>{fmtPct(h.medianExcessPct)}</td>
              <td style={cell}>{h.hitRateExcessPct == null ? '–' : `${h.hitRateExcessPct}%`}</td>
              <td style={cell}>{fmtPct(h.medianPct)}</td>
              <td style={{ ...cell, color: GREY }}>{h.unresolved ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Every rule version of a signal, each with its own result. Never summed: the
// point is to let a short recent version be read beside the long one before it.
function Versions({ row }) {
  if (!row.versions || row.versions.length < 2) return null
  const cell = { padding: '0.3rem 0.6rem', fontSize: '0.78rem', textAlign: 'left', whiteSpace: 'nowrap' }
  const th = { ...cell, color: GREY, fontWeight: 600, fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.4px' }
  return (
    <div style={{ overflowX: 'auto', marginTop: '0.7rem' }}>
      <div style={{ fontSize: '0.72rem', color: GREY, marginBottom: '0.2rem' }}>
        Rule versions, scored separately. A version covering a few weeks mostly describes those weeks.
      </div>
      <table style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr><th style={th}>Version</th><th style={th}>Fired</th><th style={{ ...th, textAlign: 'right' }}>Firings</th><th style={th}>Result</th></tr>
        </thead>
        <tbody>
          {row.versions.map(v => (
            <tr key={v.ruleVersion || 'none'} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <td style={{ ...cell, color: GREY }}>{v.ruleVersion || '–'}{v.current ? ' (current)' : ''}{v.shown ? ' · shown above' : ''}</td>
              <td style={{ ...cell, color: GREY }}>{v.since ? fmtDate(v.since) : '–'} → {v.until ? fmtDate(v.until) : '–'}</td>
              <td style={{ ...cell, textAlign: 'right' }}>{v.firings.toLocaleString()}</td>
              <td style={{ ...cell, color: TONE[v.state] || GREY, fontWeight: 600, whiteSpace: 'normal' }}>{v.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Row({ row, open, onToggle }) {
  const td = { padding: '0.55rem 0.6rem', fontSize: '0.84rem', verticalAlign: 'top' }
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <td style={{ ...td, width: '1.2rem', color: GREY }} aria-hidden="true">{open ? '▾' : '▸'}</td>
        <td style={td}>
          <button type="button" aria-expanded={open} onClick={(e) => { e.stopPropagation(); onToggle() }}
            style={{ all: 'unset', cursor: 'pointer', fontWeight: 600 }}>{row.label}</button>
          <div style={{ fontSize: '0.7rem', color: GREY }}>
            {row.signal}
            {row.supersededRules && <span title="Measured under an earlier version of this rule. Nothing has resolved under the current version yet." style={{ marginLeft: '0.4rem', color: '#fcd34d', cursor: 'help' }}>earlier rules</span>}
          </div>
        </td>
        <td style={{ ...td, color: GREY, whiteSpace: 'nowrap' }}>{row.market === 'IN' ? 'India' : row.market}</td>
        <td style={{ ...td, color: GREY, whiteSpace: 'nowrap' }}>{evidenceLabel(row.source)}</td>
        <td style={{ ...td, color: TONE[row.headline?.state] || GREY, fontWeight: 600 }}>{row.headline?.text}</td>
        <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>{row.firings ? row.firings.toLocaleString() : '–'}</td>
        <td style={{ ...td, color: GREY, whiteSpace: 'nowrap' }}>{row.since ? fmtDate(row.since) : '–'}</td>
      </tr>
      {open && (
        <tr>
          <td />
          <td colSpan={6} style={{ padding: '0 0.6rem 0.9rem', fontSize: '0.8rem', lineHeight: 1.55 }}>
            {row.description && <p style={{ margin: '0 0 0.5rem', color: 'var(--text-primary)' }}>{row.description}</p>}
            <p style={{ margin: 0, color: GREY, whiteSpace: 'pre-line', maxWidth: '900px' }}>{row.headline?.detail}</p>
            <Horizons row={row} />
            <Versions row={row} />
            <p style={{ margin: '0.5rem 0 0', color: GREY, fontSize: '0.72rem' }}>
              {row.firings > 0 && <>{row.firings.toLocaleString()} firing{row.firings === 1 ? '' : 's'}{row.symbols ? ` across ${row.symbols} symbol${row.symbols === 1 ? '' : 's'}` : ''}{row.weeks != null ? `, ${row.weeks} distinct weeks resolved` : ''}. </>}
              {row.ruleVersion && <>Rule version {row.ruleVersion}. </>}
              {row.supersededRules && <>These are the newest results there are, but they were measured under rules that have since changed; nothing has resolved under the current rules yet. </>}
              {row.olderVersions > 0 && <>{row.olderVersions} other rule version{row.olderVersions === 1 ? ' is' : 's are'} scored separately and not listed. </>}
            </p>
          </td>
        </tr>
      )}
    </>
  )
}

export default function TrackRecord() {
  const [cards, setCards] = useState({})
  const [errors, setErrors] = useState({})
  const [pending, setPending] = useState(SOURCES.length)
  const [market, setMarket] = useState('all')
  const [openId, setOpenId] = useState(null)

  useEffect(() => {
    let on = true
    for (const s of SOURCES) {
      fetch(s.url)
        .then(async r => { const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`); return j })
        .then(j => { if (on) setCards(c => ({ ...c, [s.key]: j })) })
        .catch(e => { if (on) setErrors(x => ({ ...x, [s.key]: e.message })) })
        .finally(() => { if (on) setPending(n => n - 1) })
    }
    return () => { on = false }
  }, [])

  const rows = useMemo(() => mergeScorecards(cards), [cards])
  const shown = useMemo(() => (market === 'all' ? rows : rows.filter(r => r.market === market)), [rows, market])
  const summary = useMemo(() => summarize(shown), [shown])
  const caveats = useMemo(() => [...new Set(SOURCES.flatMap(s => cards[s.key]?.caveats || cards[s.key]?.notes || []))], [cards])

  const th = { padding: '0.45rem 0.6rem', color: GREY, fontWeight: 600, fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.5px', textAlign: 'left', whiteSpace: 'nowrap' }

  // A one-column grid whose track may shrink to nothing: #root is a flex
  // column, and without this the widest table sets the page's minimum width
  // and a phone gets a page it has to scroll sideways. With it, each table
  // scrolls inside its own panel instead.
  return (
    <div style={{ padding: '0.5rem 0', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <h2 style={{ margin: '0 0 0.25rem' }}>Track record</h2>
      <p style={{ color: GREY, fontSize: '0.85rem', margin: '0 0 1rem', maxWidth: '900px' }}>
        Every signal, score and label in this app that says something about what prices do next, and whether it has been checked against what happened.
        Results are measured as return over a benchmark, never raw return. <strong>For research only — not investment advice.</strong>
      </p>

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem' }}>
        <div role="group" aria-label="Market" style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
          {MARKETS.map(m => (
            <button key={m.key} type="button" aria-pressed={market === m.key} onClick={() => setMarket(m.key)}
              style={{ background: market === m.key ? 'rgba(56,189,248,0.15)' : 'transparent', color: market === m.key ? 'var(--text-primary)' : GREY, border: 'none', padding: '0.35rem 0.8rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}>
              {m.label}
            </button>
          ))}
        </div>
        {pending > 0 && <span style={{ fontSize: '0.78rem', color: GREY }}>Loading {pending} scorecard{pending === 1 ? '' : 's'}… the first load of a day recomputes them and can take a minute.</span>}
      </div>

      {SOURCES.filter(s => errors[s.key]).map(s => (
        <div key={s.key} className="glass-panel" style={{ padding: '0.6rem 1rem', marginBottom: '0.6rem', color: '#fca5a5', fontSize: '0.82rem' }}>
          {s.name} could not be loaded ({errors[s.key]}). Its rows are missing below; the others are unaffected.
        </div>
      ))}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
        {STATUS_ORDER.map(s => (
          <a key={s} href={`#tr-${s}`} className="glass-panel" style={{ padding: '0.8rem 1rem', textDecoration: 'none', color: 'inherit', borderLeft: `3px solid ${STATUS_ACCENT[s]}` }}>
            <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: GREY }}>{STATUS_META[s].title}</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>{summary.counts[s]}<span style={{ fontSize: '0.8rem', fontWeight: 500, color: GREY }}> of {summary.total}</span></div>
          </a>
        ))}
      </div>

      {STATUS_ORDER.map(status => {
        const list = sortRows(shown.filter(r => r.status === status))
        return (
          <section key={status} id={`tr-${status}`} className="glass-panel" style={{ padding: '1rem 1.1rem', marginBottom: '1rem', borderLeft: `3px solid ${STATUS_ACCENT[status]}` }}>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>{STATUS_META[status].title} <span style={{ color: GREY, fontWeight: 500 }}>· {list.length}</span></h3>
            <p style={{ margin: '0.2rem 0 0.6rem', fontSize: '0.8rem', color: GREY, maxWidth: '900px' }}>{STATUS_META[status].blurb}</p>
            {list.length === 0 ? (
              <p style={{ margin: 0, fontSize: '0.82rem', color: GREY }}>{pending > 0 ? 'Loading…' : 'Nothing in this state.'}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={th} />
                      <th style={th}>Signal</th>
                      <th style={th}>Market</th>
                      <th style={th}>Evidence</th>
                      <th style={th}>Result</th>
                      <th style={{ ...th, textAlign: 'right' }}>Firings</th>
                      <th style={th}>Since</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map(r => <Row key={r.id} row={r} open={openId === r.id} onToggle={() => setOpenId(id => (id === r.id ? null : r.id))} />)}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )
      })}

      {caveats.length > 0 && (
        <details className="glass-panel" style={{ padding: '0.8rem 1.1rem', fontSize: '0.8rem', color: GREY }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>How these numbers are measured, and their limits ({caveats.length})</summary>
          <ul style={{ margin: '0.6rem 0 0', paddingLeft: '1.1rem', lineHeight: 1.55 }}>
            <li><strong>Recorded</strong> rows were written the day the signal fired, before the outcome existed. <strong>Reconstructed</strong> rows were rebuilt later from stored prices. They are never added together.</li>
            {caveats.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </details>
      )}
    </div>
  )
}
