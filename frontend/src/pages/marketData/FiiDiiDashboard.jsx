import { useMemo, useState } from 'react'
import {
  ComposedChart, BarChart, Bar, Line, Area, Cell,
  XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { useFetchWithAbort } from '../../hooks/useFetchWithAbort'

// ─── Conventions (mirrors MacroEconomics.jsx) ───────────────────
const TOOLTIP_PROPS = {
  contentStyle: { background: '#1e293b', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '0.8rem' },
  labelStyle: { color: 'var(--text-secondary)' },
  // Force readable value text: the per-Cell colored bars expose no series
  // color to the tooltip, so recharts would otherwise render dark item text
  // on the dark tooltip background.
  itemStyle: { color: 'var(--text-primary)' },
}
const GRID = <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
const tick = { fill: 'var(--text-secondary)', fontSize: 11 }

// FII vs DII get distinct hues; green/red are reserved for net sign / longs vs shorts.
const FII_COLOR = '#38bdf8'   // cyan / accent
const DII_COLOR = '#a78bfa'   // violet
const POS = 'var(--success)'
const NEG = 'var(--danger)'

// Cap-segment overlays. `field` matches the per-flow-row key the backend attaches.
const INDICES = [
  { field: 'nifty50_close',     label: 'Nifty 50',     color: '#e2e8f0' }, // large cap
  { field: 'midcap100_close',   label: 'Midcap 100',   color: '#fbbf24' }, // mid cap
  { field: 'smallcap250_close', label: 'Smallcap 250', color: '#f472b6' }, // small cap
]
const INDEX_LABELS = INDICES.map(i => i.label)
const MIN_CORR_N = 15 // below this, correlations are too noisy to show

// ─── Date-range presets (shape mirrors MarketDataTable PRESETS) ──
const isoToday = (off = 0) => { const d = new Date(); d.setDate(d.getDate() - off); return d.toISOString().slice(0, 10) }
const PRESETS = [
  { key: '1m',  label: '1M',  range: () => ({ from: isoToday(30),  to: isoToday(0) }) },
  { key: '3m',  label: '3M',  range: () => ({ from: isoToday(90),  to: isoToday(0) }) },
  { key: '6m',  label: '6M',  range: () => ({ from: isoToday(180), to: isoToday(0) }) },
  { key: '1y',  label: '1Y',  range: () => ({ from: isoToday(365), to: isoToday(0) }) },
  { key: 'ytd', label: 'YTD', range: () => ({ from: `${new Date().getFullYear()}-01-01`, to: isoToday(0) }) },
  { key: 'all', label: 'All', range: () => ({ from: '', to: '' }) },
]

// ─── Formatters ─────────────────────────────────────────────────
const signColor = (v) => (v == null ? 'var(--text-primary)' : v >= 0 ? POS : NEG)
function fmtCr(v, withSign = false) {
  if (v == null || isNaN(v)) return '—'
  const sign = v < 0 ? '−' : (withSign ? '+' : '')
  return `${sign}₹${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`
}
const fmtInt = (v) => (v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-IN'))
const fmtRatio = (v) => (v == null || !isFinite(v) ? '—' : v.toFixed(2))
const fmtDate = (d) => { try { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) } catch { return d } }
const sumNet = (arr, key, n) => arr.slice(-n).reduce((s, r) => s + (Number(r[key]) || 0), 0)
const fmtCorr = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`)
const corrColor = (v) => (v == null ? 'var(--text-secondary)' : Math.abs(v) < 0.15 ? 'var(--text-secondary)' : v > 0 ? POS : NEG)

// Pearson correlation of two equal-length numeric arrays.
function pearson(xs, ys) {
  const n = xs.length
  if (n < 2) return null
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0
  for (let i = 0; i < n; i++) { const x = xs[i], y = ys[i]; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y }
  const cov = sxy - (sx * sy) / n
  const den = Math.sqrt((sxx - (sx * sx) / n) * (syy - (sy * sy) / n))
  return den === 0 ? null : cov / den
}

// Correlate FII/DII net flow against a segment's daily return — both same-day
// and flow-leads-price (flow[t] vs return[t+1]). Returns nulls if the index
// series isn't present (broker session offline).
function correlateFlowVsIndex(series, field) {
  const ret = [], fii = [], dii = []
  for (let i = 1; i < series.length; i++) {
    const c0 = series[i - 1][field], c1 = series[i][field]
    if (c0 == null || c1 == null || c0 === 0) continue
    ret.push(c1 / c0 - 1); fii.push(Number(series[i].fii_net) || 0); dii.push(Number(series[i].dii_net) || 0)
  }
  const lret = [], lfii = [], ldii = []
  for (let i = 1; i < series.length - 1; i++) {
    const c0 = series[i][field], c1 = series[i + 1][field]
    if (c0 == null || c1 == null || c0 === 0) continue
    lret.push(c1 / c0 - 1); lfii.push(Number(series[i].fii_net) || 0); ldii.push(Number(series[i].dii_net) || 0)
  }
  const n = ret.length
  const enough = n >= MIN_CORR_N
  return {
    n,
    fiiSame: enough ? pearson(fii, ret) : null,
    diiSame: enough ? pearson(dii, ret) : null,
    fiiLead: lret.length >= MIN_CORR_N ? pearson(lfii, lret) : null,
    diiLead: lret.length >= MIN_CORR_N ? pearson(ldii, lret) : null,
  }
}

function MetricCard({ label, value, sub, valueColor, accent }) {
  return (
    <div className="glass-panel stat-card" style={{ padding: '0.9rem 1.1rem', borderLeft: accent ? `4px solid ${accent}` : undefined }}>
      <span className="label" style={{ fontSize: '0.68rem', marginBottom: '0.25rem' }}>{label}</span>
      <span className="value" style={{ fontSize: '1.4rem', color: valueColor }}>{value}</span>
      {sub && <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>{sub}</span>}
    </div>
  )
}

function ChartSection({ title, badge, hint, source, height = 300, children }) {
  return (
    <section className="glass-panel" style={{ padding: '1.1rem 1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', marginBottom: '0.35rem', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '1.02rem' }}>{title}</h3>
        {badge && (
          <span style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--accent)', background: 'rgba(56,189,248,0.12)', padding: '0.15rem 0.55rem', borderRadius: '999px' }}>
            {badge}
          </span>
        )}
      </div>
      {hint && <p style={{ margin: '0 0 0.6rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{hint}</p>}
      {children
        ? <ResponsiveContainer width="100%" height={height}>{children}</ResponsiveContainer>
        : <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>No data for the selected range.</p>}
      {source && <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginTop: '0.5rem', opacity: 0.8 }}>Source: {source}</div>}
    </section>
  )
}

export default function FiiDiiDashboard() {
  const [presetKey, setPresetKey] = useState('6m')
  const { from, to } = (PRESETS.find(p => p.key === presetKey) || PRESETS[2]).range()
  const qs = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&')
  const url = `/api/fiidii-overview${qs ? `?${qs}` : ''}`
  const { data, error, loading } = useFetchWithAbort(url, { deps: [url] })

  const [overlayField, setOverlayField] = useState('nifty50_close')
  const availByField = Object.fromEntries((data?.indices || []).map(m => [m.field, m.available]))
  const anyIndexAvailable = !!data?.meta?.indicesAvailable
  const overlay = INDICES.find(i => i.field === overlayField) || INDICES[0]
  const overlayAvail = !!availByField[overlay.field]

  // Derived series + headline stats.
  const derived = useMemo(() => {
    const flows = data?.flows || []
    const oi = data?.oi || []
    if (!flows.length) return null
    let cf = 0, cd = 0
    const series = flows.map(r => {
      cf += Number(r.fii_net) || 0
      cd += Number(r.dii_net) || 0
      return {
        ...r,
        combined_net: (Number(r.fii_net) || 0) + (Number(r.dii_net) || 0),
        cum_fii: cf,
        cum_dii: cd,
      }
    })
    const latest = series[series.length - 1]
    const N = Math.min(20, series.length)
    const recent = series.slice(-N)
    const fiiSellDays = recent.filter(r => (Number(r.fii_net) || 0) < 0).length

    // FII / DII index-futures long-short from the most recent OI row that has it.
    const oiF = [...oi].reverse().find(r => r.fii_fut_idx_long != null && r.fii_fut_idx_short != null)
    const oiD = [...oi].reverse().find(r => r.dii_fut_idx_long != null && r.dii_fut_idx_short != null)
    const fiiLS = oiF && oiF.fii_fut_idx_short ? oiF.fii_fut_idx_long / oiF.fii_fut_idx_short : null
    const diiLS = oiD && oiD.dii_fut_idx_short ? oiD.dii_fut_idx_long / oiD.dii_fut_idx_short : null

    const oiSeries = oi.map(r => ({
      ...r,
      fii_ls_ratio: r.fii_fut_idx_short ? r.fii_fut_idx_long / r.fii_fut_idx_short : null,
    }))

    // Flow ↔ segment correlations (same-day + flow-leads-price).
    const correlations = INDICES.map(ix => ({ ...ix, ...correlateFlowVsIndex(series, ix.field) }))

    return {
      series, oiSeries, latest, N, fiiSellDays,
      fii5: sumNet(series, 'fii_net', 5), dii5: sumNet(series, 'dii_net', 5),
      fii20: sumNet(series, 'fii_net', 20), dii20: sumNet(series, 'dii_net', 20),
      // Totals over the full selected range — these track the date selector.
      fiiRange: sumNet(series, 'fii_net', series.length),
      diiRange: sumNet(series, 'dii_net', series.length),
      rangeSessions: series.length,
      fiiLS, diiLS, correlations,
    }
  }, [data])

  // One-sentence decision-support read.
  const read = useMemo(() => {
    if (!derived) return null
    const { N, fiiSellDays, fii20, dii20, fiiLS } = derived
    const fiiSide = fii20 >= 0 ? 'net buyers' : 'net sellers'
    const diiSide = dii20 >= 0 ? 'absorbing (net buyers)' : 'distributing (net sellers)'
    let lsRead = ''
    if (fiiLS != null) {
      const tone = fiiLS >= 1.1 ? 'bullish' : fiiLS <= 0.9 ? 'bearish' : 'neutral'
      lsRead = ` FII index-futures long/short at ${fmtRatio(fiiLS)} → ${tone} positioning.`
    }
    return `Over the last ${N} sessions FII were ${fiiSide} (${fmtCr(fii20, true)} cumulative), selling on ${fiiSellDays}/${N} days, while DII were ${diiSide} (${fmtCr(dii20, true)}).${lsRead}`
  }, [derived])

  if (loading) return <div className="loader" />
  if (error || data?.error) {
    return <p className="negative" style={{ fontSize: '0.85rem' }}>Failed to load FII/DII data: {error?.message || data?.error}</p>
  }
  if (!derived) return <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>No FII/DII data available for the selected range.</p>

  const { series, oiSeries, latest, fiiLS, diiLS, correlations } = derived
  const hasOi = oiSeries.some(r => r.fii_fut_idx_long != null)
  const activeLabel = (PRESETS.find(p => p.key === presetKey) || PRESETS[2]).label

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '2rem' }}>
      {/* Header + date-range presets */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: '0 0 0.2rem', fontSize: '1.35rem' }}>Institutional Flow Dashboard</h2>
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
            FII vs DII cash flows, derivatives positioning, and price correlation across market-cap segments.
            {!anyIndexAvailable && ' · Index overlays unavailable (broker session offline).'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
          {PRESETS.map(p => (
            <button
              key={p.key}
              onClick={() => setPresetKey(p.key)}
              style={{
                padding: '0.35rem 0.75rem', borderRadius: '6px', fontSize: '0.78rem', cursor: 'pointer',
                border: presetKey === p.key ? '1px solid var(--accent)' : '1px solid var(--border)',
                background: presetKey === p.key ? 'rgba(56,189,248,0.12)' : 'transparent',
                color: presetKey === p.key ? 'var(--accent)' : 'var(--text-secondary)',
                fontWeight: presetKey === p.key ? 600 : 400,
              }}
            >{p.label}</button>
          ))}
        </div>
      </div>

      {/* Headline KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.75rem' }}>
        <MetricCard label={`FII Net · ${fmtDate(latest.trade_date)}`} value={fmtCr(latest.fii_net, true)} valueColor={signColor(latest.fii_net)} accent={FII_COLOR} />
        <MetricCard label={`DII Net · ${fmtDate(latest.trade_date)}`} value={fmtCr(latest.dii_net, true)} valueColor={signColor(latest.dii_net)} accent={DII_COLOR} />
        <MetricCard label="Combined Net (latest)" value={fmtCr(latest.combined_net, true)} valueColor={signColor(latest.combined_net)} />
        <MetricCard label={`FII Net · ${activeLabel}`} value={fmtCr(derived.fiiRange, true)} valueColor={signColor(derived.fiiRange)} sub={`${derived.rangeSessions} sessions`} accent={FII_COLOR} />
        <MetricCard label={`DII Net · ${activeLabel}`} value={fmtCr(derived.diiRange, true)} valueColor={signColor(derived.diiRange)} sub={`${derived.rangeSessions} sessions`} accent={DII_COLOR} />
        <MetricCard label="FII Net · 5-day" value={fmtCr(derived.fii5, true)} valueColor={signColor(derived.fii5)} sub={`20-day ${fmtCr(derived.fii20, true)}`} />
        <MetricCard label="DII Net · 5-day" value={fmtCr(derived.dii5, true)} valueColor={signColor(derived.dii5)} sub={`20-day ${fmtCr(derived.dii20, true)}`} />
        <MetricCard
          label="FII F&O Long/Short"
          value={fmtRatio(fiiLS)}
          valueColor={fiiLS == null ? 'var(--text-primary)' : fiiLS >= 1.1 ? POS : fiiLS <= 0.9 ? NEG : 'var(--text-primary)'}
          sub={fiiLS == null ? 'index futures' : fiiLS >= 1.1 ? 'bullish' : fiiLS <= 0.9 ? 'bearish' : 'neutral'}
        />
      </div>

      {/* Institutional read */}
      {read && (
        <div className="glass-panel" style={{ padding: '0.85rem 1.1rem', borderLeft: '4px solid var(--accent)' }}>
          <span style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--accent)' }}>Institutional Read</span>
          <p style={{ margin: '0.3rem 0 0', fontSize: '0.9rem', color: 'var(--text-primary)', lineHeight: 1.5 }}>{read}</p>
        </div>
      )}

      {/* Segment overlay selector — which index price to plot over the flows */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Price overlay:</span>
        {INDICES.map(ix => {
          const disabled = !availByField[ix.field]
          const active = overlay.field === ix.field
          return (
            <button
              key={ix.field}
              onClick={() => setOverlayField(ix.field)}
              disabled={disabled}
              title={disabled ? `${ix.label} unavailable (broker session offline)` : `Overlay ${ix.label}`}
              style={{
                padding: '0.3rem 0.7rem', borderRadius: '6px', fontSize: '0.76rem',
                cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
                border: active ? `1px solid ${ix.color}` : '1px solid var(--border)',
                background: active ? 'rgba(255,255,255,0.06)' : 'transparent',
                color: active ? ix.color : 'var(--text-secondary)', fontWeight: active ? 600 : 400,
              }}
            >{ix.label}</button>
          )
        })}
      </div>

      {/* 1. Daily net flows + segment overlay */}
      <ChartSection
        title={`Daily Net Flows vs ${overlay.label}`}
        badge="Cash Market"
        hint="Grouped daily net buy/sell. Watch for FII selling absorbed by DII buying — and whether the chosen segment follows the dominant side."
        source="NSE cash-market provisional data"
      >
        <ComposedChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          {GRID}
          <XAxis dataKey="trade_date" tick={tick} minTickGap={40} tickFormatter={fmtDate} />
          <YAxis yAxisId="left" tick={tick} width={52} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
          {overlayAvail && <YAxis yAxisId="right" orientation="right" tick={tick} width={52} domain={['auto', 'auto']} tickFormatter={v => `${(v / 1000).toFixed(1)}k`} />}
          <Tooltip {...TOOLTIP_PROPS} labelFormatter={fmtDate} formatter={(v, name) => [INDEX_LABELS.includes(name) ? fmtInt(v) : fmtCr(v, true), name]} />
          <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
          <ReferenceLine yAxisId="left" y={0} stroke="rgba(255,255,255,0.25)" />
          <Bar yAxisId="left" dataKey="fii_net" name="FII net" fill={FII_COLOR} fillOpacity={0.85} isAnimationActive={false} />
          <Bar yAxisId="left" dataKey="dii_net" name="DII net" fill={DII_COLOR} fillOpacity={0.85} isAnimationActive={false} />
          {overlayAvail && <Line yAxisId="right" type="monotone" dataKey={overlay.field} name={overlay.label} stroke={overlay.color} strokeWidth={1.8} dot={false} connectNulls isAnimationActive={false} />}
        </ComposedChart>
      </ChartSection>

      {/* 2. Cumulative flows */}
      <ChartSection
        title="Cumulative Net Flows"
        badge="Trend"
        hint="Running cumulative buy/sell over the period — the big-picture tug-of-war between foreign and domestic money."
        source="NSE cash-market provisional data"
      >
        <ComposedChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          {GRID}
          <XAxis dataKey="trade_date" tick={tick} minTickGap={40} tickFormatter={fmtDate} />
          <YAxis yAxisId="left" tick={tick} width={52} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
          {overlayAvail && <YAxis yAxisId="right" orientation="right" tick={tick} width={52} domain={['auto', 'auto']} tickFormatter={v => `${(v / 1000).toFixed(1)}k`} />}
          <Tooltip {...TOOLTIP_PROPS} labelFormatter={fmtDate} formatter={(v, name) => [INDEX_LABELS.includes(name) ? fmtInt(v) : fmtCr(v, true), name]} />
          <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
          <ReferenceLine yAxisId="left" y={0} stroke="rgba(255,255,255,0.25)" />
          <Area yAxisId="left" type="monotone" dataKey="cum_fii" name="Cumulative FII" stroke={FII_COLOR} strokeWidth={2} fill="rgba(56,189,248,0.12)" isAnimationActive={false} />
          <Area yAxisId="left" type="monotone" dataKey="cum_dii" name="Cumulative DII" stroke={DII_COLOR} strokeWidth={2} fill="rgba(167,139,250,0.12)" isAnimationActive={false} />
          {overlayAvail && <Line yAxisId="right" type="monotone" dataKey={overlay.field} name={overlay.label} stroke={overlay.color} strokeWidth={1.8} dot={false} connectNulls isAnimationActive={false} />}
        </ComposedChart>
      </ChartSection>

      {/* 3. Combined net / divergence */}
      <ChartSection
        title="Combined Net Flow (FII + DII)"
        badge="Divergence"
        hint="Net institutional flow per day. Green = net inflow into equities, red = net outflow."
        source="NSE cash-market provisional data"
      >
        <BarChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          {GRID}
          <XAxis dataKey="trade_date" tick={tick} minTickGap={40} tickFormatter={fmtDate} />
          <YAxis tick={tick} width={52} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
          <Tooltip {...TOOLTIP_PROPS} labelFormatter={fmtDate} formatter={(v) => [fmtCr(v, true), 'Combined net']} />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" />
          <Bar dataKey="combined_net" name="Combined net" isAnimationActive={false}>
            {series.map((d) => <Cell key={d.trade_date} fill={d.combined_net >= 0 ? POS : NEG} fillOpacity={0.8} />)}
          </Bar>
        </BarChart>
      </ChartSection>

      {/* 4. FII F&O positioning */}
      <ChartSection
        title="FII Index-Futures Positioning"
        badge="Derivatives"
        hint="Long vs short index-futures contracts and the long/short ratio (>1 net long = bullish, <1 net short = bearish)."
        source="NSE F&O participant-wise OI"
      >
        {hasOi ? (
          <ComposedChart data={oiSeries} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            {GRID}
            <XAxis dataKey="trade_date" tick={tick} minTickGap={40} tickFormatter={fmtDate} />
            <YAxis yAxisId="left" tick={tick} width={52} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
            <YAxis yAxisId="right" orientation="right" tick={tick} width={42} domain={[0, 'auto']} />
            <Tooltip {...TOOLTIP_PROPS} labelFormatter={fmtDate} formatter={(v, name) => [name === 'Long/Short' ? fmtRatio(v) : fmtInt(v), name]} />
            <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
            <ReferenceLine yAxisId="right" y={1} stroke="rgba(255,255,255,0.3)" strokeDasharray="6 4" />
            <Line yAxisId="left" type="monotone" dataKey="fii_fut_idx_long" name="Long" stroke={POS} strokeWidth={1.8} dot={false} connectNulls isAnimationActive={false} />
            <Line yAxisId="left" type="monotone" dataKey="fii_fut_idx_short" name="Short" stroke={NEG} strokeWidth={1.8} dot={false} connectNulls isAnimationActive={false} />
            <Line yAxisId="right" type="monotone" dataKey="fii_ls_ratio" name="Long/Short" stroke="var(--accent)" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls isAnimationActive={false} />
          </ComposedChart>
        ) : null}
      </ChartSection>
      {hasOi && diiLS != null && (
        <p style={{ margin: '-0.4rem 0 0', fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
          DII index-futures long/short currently {fmtRatio(diiLS)}.
        </p>
      )}

      {/* 5. Flow ↔ segment correlation (relationship, not a forecast) */}
      <section className="glass-panel" style={{ padding: '1.1rem 1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', marginBottom: '0.35rem', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: '1.02rem' }}>Flow ↔ Segment Correlation</h3>
          <span style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--accent)', background: 'rgba(56,189,248,0.12)', padding: '0.15rem 0.55rem', borderRadius: '999px' }}>Relationship</span>
        </div>
        <p style={{ margin: '0 0 0.7rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          Pearson correlation of daily net flow vs each segment's return. <b>Same-day</b> = flow and price move together;
          <b> → next day</b> = flow today vs the segment's next-day return (flow leading price). This is a descriptive
          relationship, not a forecast — and correlation is not causation.
        </p>
        {!anyIndexAvailable ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Index data unavailable — overlays require the broker session.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'right', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'left', padding: '0.4rem 0.5rem', fontWeight: 600 }}>Segment</th>
                  <th style={{ padding: '0.4rem 0.5rem', fontWeight: 600 }}>FII · same-day</th>
                  <th style={{ padding: '0.4rem 0.5rem', fontWeight: 600 }}>FII · → next day</th>
                  <th style={{ padding: '0.4rem 0.5rem', fontWeight: 600 }}>DII · same-day</th>
                  <th style={{ padding: '0.4rem 0.5rem', fontWeight: 600 }}>DII · → next day</th>
                </tr>
              </thead>
              <tbody>
                {correlations.map(c => {
                  const avail = !!availByField[c.field]
                  return (
                    <tr key={c.field} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ padding: '0.45rem 0.5rem', color: 'var(--text-primary)' }}>
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: c.color, marginRight: 8 }} />
                        {c.label}
                      </td>
                      {avail ? (
                        <>
                          <td style={{ padding: '0.45rem 0.5rem', textAlign: 'right', color: corrColor(c.fiiSame), fontWeight: 600 }}>{fmtCorr(c.fiiSame)}</td>
                          <td style={{ padding: '0.45rem 0.5rem', textAlign: 'right', color: corrColor(c.fiiLead), fontWeight: 600 }}>{fmtCorr(c.fiiLead)}</td>
                          <td style={{ padding: '0.45rem 0.5rem', textAlign: 'right', color: corrColor(c.diiSame), fontWeight: 600 }}>{fmtCorr(c.diiSame)}</td>
                          <td style={{ padding: '0.45rem 0.5rem', textAlign: 'right', color: corrColor(c.diiLead), fontWeight: 600 }}>{fmtCorr(c.diiLead)}</td>
                        </>
                      ) : (
                        <td colSpan={4} style={{ padding: '0.45rem 0.5rem', textAlign: 'right', color: 'var(--text-secondary)' }}>unavailable</td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ margin: '0.6rem 0 0', fontSize: '0.7rem', color: 'var(--text-secondary)', opacity: 0.85 }}>
          n = {correlations[0]?.n ?? 0} sessions in range. Correlations need ≥ {MIN_CORR_N} sessions to show; small samples are noisy.
          Flows are market-wide aggregates (no cap-segment breakdown exists), so these reflect how aggregate flows track each segment's price.
        </p>
      </section>
    </div>
  )
}
