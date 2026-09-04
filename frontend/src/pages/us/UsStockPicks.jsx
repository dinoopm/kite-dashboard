import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import SignalScore from '../../components/SignalScore'
import { rankRows } from '../../lib/picksRank'

// ─── US Quant Stock Picks ────────────────────────────────────────────────────
// The Indian page's shape with this market's inputs. Raw factors come from
// /api/us/stock-picks; ranking is done here so sliders re-rank instantly. The
// recorded series (default weights, traps excluded) is what the badges score —
// nothing a slider does touches it.

const FACTORS = [
  { key: 'momentum',    raw: 'momentumRaw',    label: 'Momentum',      color: '#38bdf8', help: '252-session return skipping the latest 21 (twelve months, skipping the most recent one). Measured information coefficient +0.016 (t=1.55) — the best of the five and still NOT statistically significant. A sweep of {20/5, 60/5, 120/20, 252/21} put it ahead of the others, which were flat or negative; "least bad" is what that means, not "works".' },
  { key: 'volume',      raw: 'volumeRaw',      label: 'Volume',        color: '#a3e635', help: 'Last-5 volume against the stock\'s own prior 15 sessions (i−19..i−5), scaled by authenticity (price corroboration + persistence). No delivery % exists in the US. Measured information coefficient +0.002 (t=0.74) — indistinguishable from zero. Scores 0 unless the surge exceeds 25%, so most stocks tie at the bottom and land mid-rank.' },
  { key: 'fiftyTwo',    raw: 'fiftyTwoRaw',    label: '52-week',       color: '#f59e0b', help: 'Fresh 252-session high (+1) or low (−1) in the last 5 sessions, plus proximity to the high. Adjusted closes. Measured information coefficient −0.007 (t=−0.69) — it ranked slightly BACKWARDS over the sample, though not significantly.' },
  { key: 'relStrength', raw: 'relStrengthRaw', label: 'Rel. strength', color: '#c084fc', help: '~3-month (63-session) return minus SPY\'s, in points. Measured information coefficient −0.010 (t=−1.16) — the most negative of the five; it ranked backwards over the sample, though not significantly.' },
  { key: 'revisions',   raw: 'revisionsRaw',   label: 'EPS revisions', color: '#f472b6', help: 'Net analyst EPS revisions over 30 days and the change in the current-year estimate (Yahoo). Missing = ranked neutral. Cannot be backtested — scored forward only.' },
]
const DEFAULT_WEIGHTS = { momentum: 30, volume: 20, fiftyTwo: 15, relStrength: 20, revisions: 15 }
const PRESETS = [
  { name: 'Balanced', weights: DEFAULT_WEIGHTS },
  { name: 'Momentum-heavy', weights: { momentum: 45, volume: 15, fiftyTwo: 15, relStrength: 25, revisions: 0 } },
  { name: 'Revisions-on', weights: { momentum: 25, volume: 15, fiftyTwo: 10, relStrength: 20, revisions: 30 } },
]
const PREFS_KEY = 'usStockPicks.prefs.v1'
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {} } catch { return {} } }

// "10-27" is not a date anyone reads at a glance. Render the day and the month
// name, and put the full date with the year in the tooltip.
const fmtEarnings = (iso, full = false) => {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  const opts = full
    ? { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }
    : { day: 'numeric', month: 'short', timeZone: 'UTC' }
  return d.toLocaleDateString('en-US', opts)
}

const fmtUsd = (v) => (v == null ? '—' : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`)
const fmtPct = (v, d = 1) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`)

function Chip({ color = 'var(--text-secondary)', title, children }) {
  return <span title={title} style={{ display: 'inline-block', padding: '0.05rem 0.4rem', borderRadius: '4px', border: `1px solid ${color}`, color, fontSize: '0.65rem', fontWeight: 600, marginRight: '0.3rem', whiteSpace: 'nowrap', cursor: title ? 'help' : 'default' }}>{children}</span>
}
function Bar({ pct, color }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}><div style={{ width: 54, height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3 }}><div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3 }} /></div><span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', minWidth: 24 }}>{Math.round(pct)}</span></div>
}

export default function UsStockPicks() {
  const navigate = useNavigate()
  const prefs = useRef(loadPrefs()).current
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [weights, setWeights] = useState({ ...DEFAULT_WEIGHTS, ...(prefs.weights || {}) })
  const [topN, setTopN] = useState([10, 25, 50].includes(prefs.topN) ? prefs.topN : 25)
  const [excludeTraps, setExcludeTraps] = useState(prefs.excludeTraps !== false)
  const [summary, setSummary] = useState(null)
  const [summarizing, setSummarizing] = useState(false)
  const [history, setHistory] = useState(null)
  const [backtest, setBacktest] = useState(null)
  const [backtestOpen, setBacktestOpen] = useState(false)
  const [backtestLoading, setBacktestLoading] = useState(false)
  useEffect(() => { try { localStorage.setItem(PREFS_KEY, JSON.stringify({ weights, topN, excludeTraps })) } catch { /* private mode */ } }, [weights, topN, excludeTraps])

  const load = useCallback(async () => {
    setLoading(true); setError(null); setSummary(null)
    try {
      const r = await fetch('/api/us/stock-picks')
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setData(j)
    } catch (e) { setError(e.message); setData(null) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => { fetch('/api/us/stock-picks/history?days=45').then(r => r.json()).then(setHistory).catch(() => {}) }, [])

  const ranked = useMemo(() => {
    if (!data?.stocks?.length) return []
    const stocks = excludeTraps ? data.stocks.filter(s => !s.factors.trapRisk) : data.stocks
    return rankRows(stocks, FACTORS, weights)
  }, [data, weights, excludeTraps])
  const top = ranked.slice(0, topN)

  // Diff against the newest recorded snapshot: who is new, who dropped.
  const diff = useMemo(() => {
    const latest = history?.dates?.[0]?.picks
    if (!latest) return null
    const prev = new Set(latest.map(p => p.symbol))
    const now = new Set(top.map(r => r.symbol))
    return { date: history.dates[0].date, entered: top.filter(r => !prev.has(r.symbol)).map(r => r.symbol), dropped: latest.filter(p => !now.has(p.symbol)).map(p => p.symbol) }
  }, [history, top])

  const sectorWarn = useMemo(() => {
    if (top.length < 10) return null
    const counts = {}
    for (const r of top) counts[r.sector || 'Unknown'] = (counts[r.sector || 'Unknown'] || 0) + 1
    const [sector, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
    return n / top.length >= 0.4 ? { sector, n } : null
  }, [top])

  const summarize = async () => {
    if (!data || !top.length) return
    setSummarizing(true)
    try {
      const picks = top.map(r => ({
        rank: r.rank, symbol: r.symbol, name: r.name, sector: r.sector, composite: +r.composite.toFixed(1),
        momentum_pct: +r.pct.momentum.toFixed(0), volume_pct: +r.pct.volume.toFixed(0), fifty_two_pct: +r.pct.fiftyTwo.toFixed(0), rel_strength_pct: +r.pct.relStrength.toFixed(0), revisions_pct: +r.pct.revisions.toFixed(0),
        momentum_252_21_pct: r.factors.momentumRaw == null ? null : +(r.factors.momentumRaw * 100).toFixed(1), vol_surge_pct: r.factors.surgePct, authenticity: r.factors.authenticity,
        rel_strength_pts: r.factors.relStrengthRaw, revisions_raw: r.factors.revisionsRaw, new_52w_high: r.factors.newHigh5,
        trap_risk: r.factors.trapRisk, trap_reason: r.factors.trapReason, flags: r.flags.map(f => f.id), earnings_date: r.earningsDate,
      }))
      const r = await fetch('/api/us/stock-picks/summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ period: data.period, regime: data.regime, weights, picks }) })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setSummary(j.summary)
    } catch (e) { setSummary(`_Brief unavailable: ${e.message}_`) } finally { setSummarizing(false) }
  }

  const loadBacktest = async () => {
    setBacktestOpen(o => !o)
    if (backtest || backtestLoading) return
    setBacktestLoading(true)
    try { const r = await fetch('/api/us/stock-picks/backtest'); setBacktest(await r.json()) } catch (e) { setBacktest({ error: e.message }) } finally { setBacktestLoading(false) }
  }

  const th = { textAlign: 'left', padding: '0.45rem 0.5rem', fontSize: '0.7rem', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }
  const td = { padding: '0.4rem 0.5rem', borderBottom: '1px solid rgba(255,255,255,0.04)', verticalAlign: 'middle' }
  const riskOff = data?.regime?.breadth?.label === 'risk-off'

  return (
    <div style={{ maxWidth: '1600px', width: '95%', margin: '0 auto', padding: '1.5rem 1rem' }}>
      <h2 style={{ margin: '0 0 0.25rem' }}>US Quant Stock Picks</h2>
      <p style={{ margin: '0 0 1rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
        S&P 500 + Nasdaq 100, five factors, percentile-ranked, your weights. Deterministic — the AI brief only explains the ranking it is given.
      </p>

      {/* The finding, above the table rather than under it.
          A reader who scrolls to the picks and stops — which is most of them —
          would otherwise see a ranked list with bold scores and never meet the
          sentence saying the ranking was measured and does not rank. The full
          numbers stay in the backtest panel below; this is the part that must
          not be scrollable-past. */}
      <div className="glass-panel" style={{ padding: '0.85rem 1.25rem', marginBottom: '1rem', border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.06)' }}>
        <strong style={{ color: '#fca5a5', fontSize: '0.85rem' }}>This ranking has no measured predictive skill.</strong>
        <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginLeft: '0.4rem' }}>
          Backtested over 478 evaluation dates (2017–2026), the composite's information coefficient is +0.005 (t=0.46) — indistinguishable from zero — and the quintiles are U-shaped rather than descending, which is what a volatility-selecting score looks like, not a ranking one. Order these rows however you like; the order is not evidence about what happens next. Full numbers in the backtest panel below.
        </span>
      </div>

      {/* Regime + universe */}
      {data && (
        <div className="glass-panel" style={{ padding: '0.85rem 1.25rem', marginBottom: '1rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center', border: `1px solid ${riskOff ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.25)'}` }}>
          <strong style={{ fontSize: '0.85rem' }}>{data.regime.label}</strong>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }} title="Percent of the ranked universe with positive 252/21 (twelve-month, skipping the latest month) momentum">{data.regime.breadth.pctPositiveMomentum}% positive momentum</span>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>as of {data.period.snapshotDate} · {data.universeSize} ranked</span>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }} title={data.excludedSample.join(', ')}>{data.excludedCount} excluded (illiquid / earnings ≤ 5 sessions / pump-fade)</span>
          {data.revisionsMissing > 0 && <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{data.revisionsMissing} without revisions data (ranked neutral)</span>}
        </div>
      )}

      {/* Controls */}
      <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {FACTORS.map(f => (
            <label key={f.key} title={f.help} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              <span><span style={{ color: f.color }}>■</span> {f.label}: <strong style={{ color: 'var(--text-primary)' }}>{weights[f.key]}</strong></span>
              <input type="range" min="0" max="60" value={weights[f.key]} onChange={e => setWeights(w => ({ ...w, [f.key]: +e.target.value }))} style={{ width: 130, accentColor: f.color }} />
            </label>
          ))}
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {/* Which preset you are on has to be visible, as it is on the
                Indian page: the sliders can be dragged anywhere, so without
                this the row says three presets exist but never which one is
                loaded — and after a reload, prefs restore the weights with no
                button lit at all. Matched against the weights themselves, so
                dragging back onto a preset's numbers lights it again and
                dragging off it goes dark. */}
            {PRESETS.map(p => {
              const active = FACTORS.every(f => weights[f.key] === p.weights[f.key])
              return (
                <button key={p.name} onClick={() => setWeights({ ...p.weights })}
                  aria-pressed={active}
                  style={{
                    padding: '0.3rem 0.6rem', fontSize: '0.72rem', borderRadius: 4, cursor: 'pointer',
                    fontWeight: active ? 700 : 500,
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active ? '#04141f' : 'var(--text-secondary)',
                  }}>{p.name}</button>
              )
            })}
          </div>
          <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Show <select value={topN} onChange={e => setTopN(+e.target.value)}>{[10, 25, 50].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
          <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
            <input type="checkbox" checked={excludeTraps} onChange={e => setExcludeTraps(e.target.checked)} /> Hide trap-risk names
          </label>
        </div>
      </div>

      {loading ? (
        <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center' }}>
          <div className="loader" style={{ margin: '0 auto 1rem' }} />
          <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
            Building the factor universe from ~500 symbols — daily bars plus analyst estimates for each.
            The first load after a server restart takes about 40 seconds; later ones are instant.
          </div>
        </div>
      ) : error ? (
        <div className="glass-panel" style={{ padding: '1.5rem', color: '#ef4444' }}>Failed to load: {error}</div>
      ) : !top.length ? (
        <div className="glass-panel" style={{ padding: '1.5rem', color: 'var(--text-secondary)' }}>Nothing to rank.</div>
      ) : (
        <>
          {sectorWarn && <div className="glass-panel" style={{ padding: '0.6rem 1rem', marginBottom: '0.75rem', fontSize: '0.78rem', color: '#fbbf24' }}>⚠ {sectorWarn.n} of {top.length} picks are {sectorWarn.sector} — crowded.</div>}
          {diff && (diff.entered.length || diff.dropped.length) ? (
            <div className="glass-panel" style={{ padding: '0.6rem 1rem', marginBottom: '0.75rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              vs recorded {diff.date}: {diff.entered.length ? <span style={{ color: '#34d399' }}>+ {diff.entered.join(', ')}</span> : null} {diff.dropped.length ? <span style={{ color: '#fca5a5' }}>− {diff.dropped.join(', ')}</span> : null}
            </div>
          ) : null}
          {history && history.available === false && <div className="glass-panel" style={{ padding: '0.6rem 1rem', marginBottom: '0.75rem', fontSize: '0.78rem', color: '#fcd34d' }}>{history.hint}</div>}

          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.5rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            <span>Track record (recorded picks vs SPY):</span>
            <SignalScore signal="us_picks_top25" label="Top 25" market="US" />
            <SignalScore signal="us_picks_top10" label="Top 10" market="US" />
            <button onClick={summarize} disabled={summarizing} style={{ marginLeft: 'auto', padding: '0.35rem 0.8rem', borderRadius: 4, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.75rem' }}>{summarizing ? 'Writing…' : 'AI brief'}</button>
          </div>
          {summary && <div className="glass-panel" style={{ padding: '1.1rem 1.4rem', marginBottom: '1rem', lineHeight: 1.6, fontSize: '0.9rem' }}><ReactMarkdown>{summary}</ReactMarkdown></div>}

          <div className="glass-panel" style={{ padding: '0.4rem', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead><tr>
                <th style={th}>#</th><th style={th}>Symbol</th><th style={th}>Sector</th><th style={th}>Price</th><th style={th} title="Weighted blend of the factor percentiles">Score</th>
                {FACTORS.map(f => <th key={f.key} style={th} title={f.help}>{f.label}</th>)}
                <th style={th}>Flags</th>
              </tr></thead>
              <tbody>
                {top.map(r => (
                  <tr key={r.symbol} onClick={() => navigate(`/us/${encodeURIComponent(r.symbol)}`)} style={{ cursor: 'pointer' }}>
                    <td style={td}>{r.rank}</td>
                    <td style={td}><strong>{r.symbol}</strong><div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>{r.name}</div></td>
                    <td style={{ ...td, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{r.sector || '—'}</td>
                    <td style={td}>{fmtUsd(r.lastClose)}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{r.composite.toFixed(0)}</td>
                    {FACTORS.map(f => <td key={f.key} style={td}><Bar pct={r.pct[f.key]} color={f.color} /></td>)}
                    <td style={td}>
                      {r.factors.trapRisk && <Chip color="#fbbf24" title={r.factors.trapReason}>trap</Chip>}
                      {r.factors.newHigh5 && <Chip color="#34d399" title="Fresh 252-session high in the last 5 sessions">52w high</Chip>}
                      {r.flags.map(f => <Chip key={f.id} color="#fbbf24" title={f.title}>{f.id}</Chip>)}
                      {r.earningsDate && <Chip color="#c084fc" title={`Next earnings: ${fmtEarnings(r.earningsDate, true)}`}>📅 {fmtEarnings(r.earningsDate)}</Chip>}
                      {r.factors.revisionsRaw == null && <Chip title="No EPS revisions data — ranked neutral on that factor">no rev.</Chip>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: '0.5rem 0 0' }}>
            Factors percentile-ranked across {ranked.length} stocks as of {data.period.snapshotDate}. Momentum {fmtPct(top[0]?.factors.momentumRaw == null ? null : top[0].factors.momentumRaw * 100)} means the #1 name's 252-session return, skipping the latest 21. Not investment advice.
          </p>
        </>
      )}

      {/* Backtest */}
      <div className="glass-panel" style={{ marginTop: '1.5rem', padding: '1rem 1.25rem' }}>
        <button onClick={loadBacktest} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.85rem', padding: 0 }}>{backtestOpen ? '▾' : '▸'} Backtest — four price factors, 2015 → today</button>
        <div style={{ fontSize: '0.78rem', color: '#fca5a5', fontWeight: 500, marginTop: '0.35rem', lineHeight: 1.5 }}>
          As of the 2026-08-04 run — no ranking skill measurable across 481 evaluation dates (2017–2026, 518 names): the composite information coefficient is +0.005 (t=0.46), indistinguishable from zero — momentum comes closest at +0.016 (t=1.55) and still falls short of significance. The quintiles are U-shaped, not descending: the trough sits in the middle ranks and both tails are raised — tied at 5 days (0.42% each), Q1 ahead at 10 days (0.83% vs 0.79%), Q5 back ahead at 22 days (1.67% vs 1.65%) — and the hit rate is a coin flip at 51–52%. The +0.52% top-25 edge over SPY at 10 days (t=3.89) is most plausibly beta, not skill: the top 25 is the extreme tail of a volatility-loaded composite across ~500 names, measured across a decade-long bull market — a U-shape, where both tails beat the middle, is what a volatility-selecting score looks like, not a ranking score.
        </div>
        {backtestOpen && (backtestLoading ? <div className="loader" /> : backtest?.error ? <div style={{ color: '#ef4444', marginTop: '0.5rem' }}>{backtest.error}</div> : backtest ? (
          <div style={{ marginTop: '0.75rem', fontSize: '0.8rem' }}>
            <div style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>{backtest.period.evalDates} evaluation dates, {backtest.period.firstEval} → {backtest.period.lastEval}, {backtest.period.universe} names. Revisions weight 0 here; the live model uses 15.</div>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr>
                <th style={th}>Horizon</th>
                <th style={th} title="Mean return of the top 25 minus the MEDIAN return of the whole universe. Right-skewed return distributions flatter this column — the next one is the fair comparison.">Top-25 vs median (skews high)</th>
                <th style={th} title="Mean return of the top 25 minus SPY's return over the same window — the fair comparison.">Top-25 vs SPY (fair)</th>
                <th style={th}>Top-10 vs SPY</th>
                <th style={th}>Hit rate</th>
                <th style={th} title="Mean forward return by rank quintile, best-ranked (Q1) to worst-ranked (Q5). A working model shows Q1 highest, Q5 lowest, descending — here it's U-shaped: both ends beat the middle.">Q1…Q5</th>
              </tr></thead>
              <tbody>{backtest.summary.map(s => (
                <tr key={s.horizon}><td style={td}>{s.horizon}d</td><td style={td}>{fmtPct(s.meanExcessVsMedianPct, 2)} <span style={{ color: 'var(--text-secondary)' }}>t={s.tVsMedian}</span></td><td style={td}>{fmtPct(s.meanExcessVsSpyPct, 2)} <span style={{ color: 'var(--text-secondary)' }}>t={s.tVsSpy}</span></td><td style={td}>{fmtPct(s.top10ExcessVsSpyPct, 2)}</td><td style={td}>{s.hitRatePct}%</td><td style={{ ...td, fontSize: '0.72rem' }}>{s.quintileMeansPct.map(q => q == null ? '—' : q.toFixed(2)).join(' / ')}</td></tr>
              ))}</tbody>
            </table>
            <div style={{ marginTop: '0.6rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
              <div><strong>IC (10d)</strong>{backtest.ics.map(i => <div key={i.factor} style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{i.factor}: {i.meanIC} (t={i.tStat})</div>)}</div>
              <div><strong>Momentum window sweep (10d vs SPY)</strong>{backtest.sweep.map(s => <div key={`${s.momentum.window}/${s.momentum.skip}`} style={{ fontSize: '0.75rem', color: s.shipped ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{s.momentum.window}/{s.momentum.skip}{s.shipped ? ' (shipped)' : ''}: {fmtPct(s.meanExcessVsSpyPct, 2)} t={s.tStat} IC {s.icComposite}</div>)}</div>
            </div>
            <ul style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.6rem', paddingLeft: '1.1rem' }}>{backtest.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </div>
        ) : null)}
      </div>
    </div>
  )
}
