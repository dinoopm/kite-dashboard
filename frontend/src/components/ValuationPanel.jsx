import { useState, useEffect } from 'react'
import { fetchWithAbort } from '../hooks/useFetchWithAbort'

const VERDICT_STYLE = {
  ATTRACTIVE: { color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
  FAIR: { color: '#38bdf8', bg: 'rgba(56,189,248,0.12)' },
  MIXED: { color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
  EXPENSIVE: { color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
  'NOT MEANINGFUL': { color: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
  'INSUFFICIENT DATA': { color: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
}
const SIGNAL_COLOR = { cheap: '#10b981', fair: '#38bdf8', expensive: '#ef4444' }
const SIGNAL_WORD = { cheap: 'CHEAP', fair: 'FAIR', expensive: 'EXPENSIVE' }
const LENS_LABEL = { peers: 'vs Peers', history: 'vs Own History', growth: 'Growth-adjusted', intrinsic: 'Intrinsic anchors', dcf: 'Reverse DCF (plausibility)' }

const fmt = (v, suffix = '', dash = '—') => (v == null ? dash : `${v}${suffix}`)
const signed = (v, suffix = '%') => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}${suffix}`)
const pnlClass = (v, invert = false) => {
  if (v == null) return ''
  const pos = invert ? v < 0 : v > 0
  return pos ? 'positive' : 'negative'
}

function LensPanel({ name, lens, children }) {
  const sig = lens?.status === 'ok' ? lens.signal : null
  return (
    <div className="glass-panel" style={{ padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {LENS_LABEL[name]}
        </span>
        {sig
          ? <span style={{ fontSize: '0.7rem', fontWeight: 800, color: SIGNAL_COLOR[sig], border: `1px solid ${SIGNAL_COLOR[sig]}`, borderRadius: '999px', padding: '0.1rem 0.6rem' }}>{SIGNAL_WORD[sig]}</span>
          : <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>insufficient data</span>}
      </div>
      {lens?.status === 'ok'
        ? children
        : <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{lens?.reason || 'Not enough data to evaluate this lens.'}</p>}
    </div>
  )
}

function Stat({ label, value, cls, hint }) {
  return (
    <div title={hint} style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem', minWidth: '110px' }}>
      <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>{label}</span>
      <span className={cls || ''} style={{ fontSize: '1.05rem', fontWeight: 700 }}>{value}</span>
    </div>
  )
}

// Horizontal min→max band with a marker at the current value.
function Band({ min, max, current }) {
  if (min == null || max == null || current == null || max <= min) return null
  const pos = Math.min(100, Math.max(0, ((current - min) / (max - min)) * 100))
  return (
    <div style={{ marginTop: '0.4rem' }}>
      <div style={{ position: 'relative', height: '8px', borderRadius: '4px', background: 'linear-gradient(90deg, rgba(16,185,129,0.5), rgba(251,191,36,0.5), rgba(239,68,68,0.5))' }}>
        <div style={{ position: 'absolute', left: `${pos}%`, top: '-3px', width: '3px', height: '14px', background: 'var(--text-primary)', borderRadius: '2px', transform: 'translateX(-50%)' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
        <span>{min}× low</span>
        <span>{max}× high</span>
      </div>
    </div>
  )
}

export default function ValuationPanel({ symbol, token }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!symbol) return
    const controller = new AbortController()
    ;(async () => {
      try {
        setLoading(true)
        setError(null)
        const qs = token ? `?token=${encodeURIComponent(token)}` : ''
        const res = await fetchWithAbort(`/api/valuation/${encodeURIComponent(symbol)}${qs}`, { signal: controller.signal, timeoutMs: 90000 })
        const d = await res.json()
        if (!res.ok) throw new Error(d.error || `Valuation failed (${res.status})`)
        setData(d)
      } catch (e) {
        if (e.name === 'AbortError') return
        setError(e.message)
      } finally {
        setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [symbol, token])

  if (loading) return <div className="loader" />
  if (error) return <p className="negative">{error}</p>
  if (!data) return null

  const { verdict, lenses, caveats = [], inputErrors = [], flags = {} } = data
  const vs = VERDICT_STYLE[verdict.label] || VERDICT_STYLE.FAIR
  const { peers, history, growth, intrinsic, dcf = { status: 'insufficient' } } = lenses

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Verdict card */}
      <div className="glass-panel" style={{ padding: '1.25rem 1.5rem', display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap', borderLeft: `4px solid ${vs.color}` }}>
        <div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>
            Valuation verdict {data.industry ? `· ${data.industry}` : ''}
          </div>
          <span style={{ fontSize: '1.6rem', fontWeight: 800, color: vs.color, background: vs.bg, padding: '0.2rem 0.9rem', borderRadius: '10px' }}>
            {verdict.label}
          </span>
        </div>
        <div style={{ flex: 1, minWidth: '220px' }}>
          {verdict.headline && <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>{verdict.headline}</div>}
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Based on {verdict.lensesUsed} of {verdict.totalLenses || 5} lenses · price ₹{data.price}
            {verdict.confidence && (
              <span style={{
                marginLeft: '0.6rem', padding: '0.05rem 0.5rem', borderRadius: '999px', fontWeight: 700,
                color: verdict.confidence === 'high' ? '#10b981' : verdict.confidence === 'moderate' ? '#fbbf24' : '#94a3b8',
                border: `1px solid ${verdict.confidence === 'high' ? '#10b981' : verdict.confidence === 'moderate' ? '#fbbf24' : '#94a3b8'}`,
              }}>
                {verdict.confidence} confidence
              </span>
            )}
          </div>
          {verdict.note && (
            <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginTop: '0.35rem', maxWidth: '560px' }}>
              {verdict.note}
            </div>
          )}
        </div>
      </div>

      {(caveats.length > 0 || inputErrors.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {caveats.map((c, i) => (
            <div key={i} style={{ fontSize: '0.78rem', color: '#fbbf24', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: '8px', padding: '0.5rem 0.9rem' }}>⚠ {c}</div>
          ))}
          {inputErrors.map((e, i) => (
            <div key={i} style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>· {e.input} unavailable ({e.error})</div>
          ))}
        </div>
      )}

      {/* Cross-lens P/E reconciliation: the two panels intentionally use
          different EPS bases (each internally consistent) — say so when the
          figures visibly diverge instead of letting users assume a bug. */}
      {peers.status === 'ok' && history.status === 'ok' && peers.currentPE != null && history.currentPE != null
        && Math.abs(peers.currentPE - history.currentPE) / history.currentPE > 0.05 && (
        <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.2)', borderRadius: '8px', padding: '0.5rem 0.9rem' }}>
          ℹ The Peers panel ({peers.currentPE}×) and History panel ({history.currentPE}×) show different P/E figures by design — Peers uses screener's industry-table P/E so it matches the peer median's basis, while History uses live price ÷ TTM EPS to match its own band. Compare within a panel, not across panels.
        </div>
      )}

      {/* Lens grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '1rem' }}>
        <LensPanel name="peers" lens={peers}>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            <Stat label={`P/E (${peers.peBasis || 'TTM'})`} value={fmt(peers.currentPE, '×')} />
            <Stat
              label={`Peer median P/E${peers.peerCount ? ` (n=${peers.peerCount})` : ''}`}
              value={fmt(peers.medianPE, '×')}
              hint={peers.peIqr ? `Peer interquartile range: ${peers.peIqr[0]}× – ${peers.peIqr[1]}×` : undefined}
            />
            <Stat label="Premium / discount" value={signed(peers.premiumPct)} cls={pnlClass(peers.premiumPct, true)} />
          </div>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            <Stat label="ROCE" value={fmt(peers.roce, '%')} />
            <Stat label="Peer median ROCE" value={fmt(peers.medianRoce, '%')} />
          </div>
          {peers.roceVsMedian === 'below' && peers.premiumPct > 0 && (
            <p style={{ margin: 0, fontSize: '0.75rem', color: '#fbbf24' }}>Premium NOT backed by superior ROCE — paying up for below-median capital efficiency.</p>
          )}
          {peers.roceVsMedian === 'above' && peers.premiumPct > 0 && (
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Premium is at least partly earned — ROCE is above the peer median.</p>
          )}
          {peers.roceVsMedian === 'inline' && (
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Capital efficiency is in line with peers (ROCE within ±0.5pp of the median).</p>
          )}
        </LensPanel>

        <LensPanel name="history" lens={history}>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            <Stat label={`Current P/E (${history.peBasis || ''})`} value={fmt(history.currentPE, '×')} />
            <Stat
              label={`Percentile in own range${history.sampleCount ? ` (n=${history.sampleCount} ${history.sampling || ''})` : ''}`}
              value={fmt(history.percentile, 'th')}
              cls={history.percentile >= 75 ? 'negative' : history.percentile <= 25 ? 'positive' : ''}
            />
          </div>
          <Band min={history.min} max={history.max} current={history.currentPE} />
          {history.cycleAdjustedPE != null && (
            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
              Cycle-adjusted P/E (price ÷ 5-yr avg EPS): <strong style={{ color: 'var(--text-primary)' }}>{history.cycleAdjustedPE}×</strong>
            </div>
          )}
          {history.fyPoints?.length > 0 && (
            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
              FY-end P/E: {history.fyPoints.map(p => `${p.label} ${p.pe}×`).join(' · ')}
            </div>
          )}
        </LensPanel>

        <LensPanel name="growth" lens={growth}>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            <Stat label="EPS CAGR (3y)" value={signed(growth.epsCagr3y)} cls={pnlClass(growth.epsCagr3y)} />
            <Stat label="EPS CAGR (5y)" value={signed(growth.epsCagr5y)} cls={pnlClass(growth.epsCagr5y)} />
            <Stat label="Revenue CAGR (3y)" value={signed(growth.revenueCagr3y)} cls={pnlClass(growth.revenueCagr3y)} />
          </div>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            <Stat label="PEG" value={fmt(growth.peg, '×')} hint="P/E ÷ 3y EPS CAGR — under 1 is conventionally cheap, over 2 expensive" />
            <Stat label="Forward P/E" value={fmt(growth.forwardPE, '×')} hint="Price ÷ consensus next-year EPS (Yahoo estimate)" />
            <Stat label="Earnings yield" value={fmt(growth.earningsYield, '%')} hint="1 ÷ P/E" />
            <Stat label={`vs 10Y G-Sec proxy ${fmt(growth.tenYearProxy, '%')}`} value={signed(growth.yieldGap, ' pp')} cls={pnlClass(growth.yieldGap)}
              hint={`Earnings yield minus a 10-year India G-Sec PROXY constructed as repo ${fmt(growth.policyRate, '%')} + 120bps term premium (not a live bond quote). No equity risk premium applied — a fair gap should really be positive.`} />
          </div>
        </LensPanel>

        <LensPanel name="intrinsic" lens={intrinsic}>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            <Stat label="P/B" value={fmt(intrinsic.pb, '×')} />
            <Stat
              label="Justified P/B"
              value={fmt(intrinsic.justifiedPB, '×')}
              hint={intrinsic.coeAssumptions
                ? `Residual income: (ROE − g)/(r − g) with r = ${intrinsic.coeAssumptions.costOfEquity}% (10Y proxy + ${intrinsic.coeAssumptions.erp}pp ERP), g = ${intrinsic.coeAssumptions.growth}%`
                : 'Residual income fair multiple'}
            />
            <Stat
              label="P/B vs justified"
              value={fmt(intrinsic.pbVsJustified, '×')}
              cls={intrinsic.pbVsJustified != null ? (intrinsic.pbVsJustified > 1.5 ? 'negative' : intrinsic.pbVsJustified < 0.75 ? 'positive' : '') : ''}
              hint="Actual P/B ÷ justified P/B — above 1.5× reads expensive, below 0.75× cheap"
            />
          </div>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            <Stat label={`BVPS (${intrinsic.balanceSheetYear || 'latest'})`} value={fmt(intrinsic.bvps ? `₹${intrinsic.bvps}` : null)} />
            <Stat label="FCF yield" value={fmt(intrinsic.fcfYieldPct, '%')} />
            <Stat label="ROE" value={fmt(intrinsic.roePct, '%')} />
            <Stat label="EV/EBITDA" value={fmt(intrinsic.evEbitda, '×')} hint="Enterprise value ÷ EBITDA (Yahoo) — leverage-aware multiple" />
            {intrinsic.debtToEquity != null && (
              <Stat label="Debt / equity" value={fmt(intrinsic.debtToEquity, '×')} cls={intrinsic.debtToEquity > 1.5 ? 'negative' : ''}
                hint="Gross borrowings ÷ net worth (screener balance sheet)" />
            )}
          </div>
          <p style={{ margin: 0, fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
            {intrinsic.signalBasis ? `Signal from ${intrinsic.signalBasis}. ` : ''}
            {intrinsic.grahamNumber != null ? `Graham heuristic (1949-era, footnote only): ₹${intrinsic.grahamNumber} (${intrinsic.grahamUpsidePct > 0 ? '+' : ''}${intrinsic.grahamUpsidePct}% vs price).` : ''}
          </p>
          {flags.isFinancial && (
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Bank/NBFC — read P/B and ROE first; Graham/FCF metrics are secondary here.</p>
          )}
        </LensPanel>

        <LensPanel name="dcf" lens={dcf}>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            <Stat
              label="Price implies (10y FCF growth)"
              value={dcf.impliedGrowthPct != null ? `${dcf.impliedCapped ? '≥' : ''}${dcf.impliedGrowthPct}%/yr` : '—'}
              hint="The constant FCF growth rate over 10 years that makes the DCF equal today's market cap"
            />
            <Stat
              label="Delivered (5y, smoothed)"
              value={fmt(dcf.historicalFcfCagr5y, '%/yr')}
              hint="CAGR between the 3-yr average FCF five years ago and today's 3-yr average"
            />
            <Stat
              label="Implied − delivered"
              value={(dcf.impliedGrowthPct != null && dcf.historicalFcfCagr5y != null)
                ? signed(+(dcf.impliedGrowthPct - dcf.historicalFcfCagr5y).toFixed(1), ' pp') : '—'}
              cls={(dcf.impliedGrowthPct != null && dcf.historicalFcfCagr5y != null)
                ? pnlClass(dcf.historicalFcfCagr5y - dcf.impliedGrowthPct) : ''}
              hint="Positive = the market is pricing in an acceleration vs delivered growth"
            />
          </div>
          {dcf.valueRange && (
            <div style={{ fontSize: '0.78rem' }}>
              Value range at delivered growth ({dcf.valueRange.anchorGrowthPct}%/yr):{' '}
              <strong>₹{dcf.valueRange.low} – ₹{dcf.valueRange.high}</strong>
              <span style={{ color: 'var(--text-secondary)' }}> (mid ₹{dcf.valueRange.mid})</span>
              <span className="info-icon" title="Sensitivity across cost of equity ±1pp × growth ±2pp — shown as a range because a single DCF 'fair value' overstates precision">{' '}ⓘ</span>
            </div>
          )}
          {dcf.assumptions && (
            <p style={{ margin: 0, fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
              Assumptions: r = {dcf.assumptions.costOfEquity}% (10Y G-Sec proxy + 5pp ERP) · terminal g = {dcf.assumptions.terminalGrowthPct}% · base = {dcf.assumptions.base} ₹{dcf.baseFcfCr} Cr · {dcf.assumptions.horizonYears}y horizon. Screener FCF treated as equity cash flow.
            </p>
          )}
        </LensPanel>
      </div>

      <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', margin: 0 }}>
        Rule-of-thumb assessment from screener.in, Yahoo Finance and RBI policy data — thresholds are conventional (±25% vs peers, PEG 1/2) and the reverse DCF is a plausibility test with stated assumptions, not a price target. Not investment advice. Cached up to 1h.
      </p>
    </div>
  )
}
