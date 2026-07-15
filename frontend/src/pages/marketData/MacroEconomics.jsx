import { useMemo } from 'react'
import {
  LineChart, Line, BarChart, Bar, ComposedChart, Area, Cell,
  XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer,
  ReferenceLine, ReferenceArea,
} from 'recharts'
import { useFetchWithAbort } from '../../hooks/useFetchWithAbort'
import { fmtDate } from '../../lib/formatDate'

const TOOLTIP_PROPS = {
  contentStyle: { background: '#1e293b', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '0.8rem' },
  labelStyle: { color: 'var(--text-secondary)' },
}
const GRID = <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
const tick = { fill: 'var(--text-secondary)', fontSize: 11 }

const fmtPct = (v, digits = 1) => (v == null ? '—' : `${Number(v).toFixed(digits)}%`)
const fmtNum = (v) => (v == null ? '—' : Number(v).toLocaleString('en-IN'))

function MetricCard({ label, value, sub, valueClass, accent }) {
  return (
    <div className="glass-panel stat-card" style={{ padding: '0.9rem 1.1rem', borderLeft: accent ? `4px solid ${accent}` : undefined }}>
      <span className="label" style={{ fontSize: '0.68rem', marginBottom: '0.25rem' }}>{label}</span>
      <span className={`value ${valueClass || ''}`} style={{ fontSize: '1.45rem' }}>{value}</span>
      {sub && <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>{sub}</span>}
    </div>
  )
}

function ChartSection({ title, badge, source, height = 300, children }) {
  return (
    <section className="glass-panel" style={{ padding: '1.1rem 1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '1.02rem' }}>{title}</h3>
        {badge && (
          <span style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--accent)', background: 'rgba(56,189,248,0.12)', padding: '0.15rem 0.55rem', borderRadius: '999px' }}>
            {badge}
          </span>
        )}
      </div>
      {children ? (
        <ResponsiveContainer width="100%" height={height}>{children}</ResponsiveContainer>
      ) : (
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Section unavailable — source file failed to load.</p>
      )}
      {source && (
        <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginTop: '0.5rem', opacity: 0.8 }}>
          Source: {source}
        </div>
      )}
    </section>
  )
}

export default function MacroEconomics() {
  const { data, error, loading } = useFetchWithAbort('/api/macro-overview')
  const macro = data && !data.error ? data : null

  const { summary, policy, inflation, gdpGrowth, external, fiscal, forex, sectors, rates } = macro || {}
  const band = inflation?.targetBand || { lower: 2, upper: 6 }
  const cpiLatest = policy?.cpiLatest ?? summary?.cpiInflation ?? null
  const cpiInBand = cpiLatest != null && cpiLatest >= band.lower && cpiLatest <= band.upper

  // Lending / deposit / M3 series share FY-label years — merge for one chart.
  const ratesMerged = useMemo(() => {
    if (!rates) return []
    const byYear = new Map()
    const add = (series, key) => (series || []).forEach(({ year, value }) => {
      if (!byYear.has(year)) byYear.set(year, { year })
      byYear.get(year)[key] = value
    })
    add(rates.lendingRate?.series, 'lending')
    add(rates.depositRate?.series, 'deposit')
    add(rates.broadMoneyGrowth?.series, 'm3')
    return [...byYear.values()].sort((a, b) => a.year.localeCompare(b.year))
  }, [rates])

  if (loading) return <div className="loader" />
  if (error || data?.error) {
    return (
      <div>
        <h1>Macro Economics</h1>
        <p className="negative">Failed to load macro data: {error?.message || data?.error}</p>
      </div>
    )
  }
  if (!macro) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div>
        <h1 style={{ marginBottom: '0.25rem' }}>Macro Economics</h1>
        <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.85rem' }}>
          India's macro backdrop for market analysis — rates, inflation, growth, fiscal &amp; external balances.
          {' '}Data: indiandataproject.org (Govt Open Data License) · FY {macro.fy}
          {summary?.lastUpdated ? ` · Updated ${fmtDate(summary.lastUpdated)}` : ''} · Annual/quarterly series — not live.
        </p>
        {macro.stale && (
          <p style={{ color: '#fbbf24', fontSize: '0.8rem', margin: '0.4rem 0 0' }}>
            ⚠ Showing cached data — the upstream source is currently unreachable.
          </p>
        )}
        {macro.errors?.length > 0 && (
          <p style={{ color: '#fbbf24', fontSize: '0.75rem', margin: '0.4rem 0 0' }}>
            ⚠ Some sections failed to load: {macro.errors.map(e => e.file).join(', ')}
          </p>
        )}
      </div>

      {/* Headline cards — market-relevance order */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' }}>
        <MetricCard
          label="RBI Repo Rate"
          value={fmtPct(policy?.repoRate, 2)}
          sub={[policy?.stance ? `Stance: ${policy.stance}` : null, policy?.repoRateLive ? 'live · rbi.org.in' : null].filter(Boolean).join(' · ') || null}
          accent="var(--accent)"
        />
        <MetricCard label="CPI Inflation" value={fmtPct(cpiLatest, 2)} sub={`Target ${band.lower}–${band.upper}%`} valueClass={cpiLatest == null ? '' : cpiInBand ? 'positive' : 'negative'} />
        <MetricCard label="Real GDP Growth" value={fmtPct(summary?.realGDPGrowth)} sub={summary?.projectedGrowthHigh != null ? `FY${macro.fy.slice(2, 4)}–${macro.fy.slice(5)} proj ${fmtPct(summary.projectedGrowthHigh)}` : null} valueClass={summary?.realGDPGrowth > 0 ? 'positive' : 'negative'} />
        <MetricCard label="Fiscal Deficit" value={fmtPct(summary?.fiscalDeficitPercentGDP)} sub="of GDP" />
        <MetricCard label="Current Account" value={fmtPct(summary?.currentAccountDeficitPercentGDP)} sub="of GDP" valueClass={summary?.currentAccountDeficitPercentGDP >= 0 ? 'positive' : 'negative'} />
        <MetricCard label="Forex Reserves" value={policy?.forexReservesUSD != null ? `$${fmtNum(policy.forexReservesUSD)}B` : '—'} sub={policy?.crr != null ? `CRR ${fmtPct(policy.crr)} · SLR ${fmtPct(policy.slr)}` : null} />
      </div>

      {/* 1. Repo rate decision timeline */}
      <ChartSection title="RBI Repo Rate Timeline" badge="Monetary Policy" source="RBI MPC press releases + indiandataproject.org" >
        {policy?.historyIncomplete && (
          <p style={{ color: '#fbbf24', fontSize: '0.75rem', margin: '0 0 0.5rem' }}>
            ⚠ The live repo rate ({fmtPct(policy.repoRate, 2)}) differs from the last decision on record — recent MPC moves may be missing from this timeline.
          </p>
        )}
        {policy?.decisions?.length ? (
          <LineChart data={policy.decisions} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            {GRID}
            <XAxis dataKey="date" tick={tick} minTickGap={50} tickFormatter={d => d.slice(0, 7)} />
            <YAxis tick={tick} domain={['auto', 'auto']} width={42} tickFormatter={v => `${v}%`} />
            <Tooltip
              {...TOOLTIP_PROPS}
              formatter={(v, _n, item) => {
                const d = item?.payload
                const chg = d?.change ? ` (${d.change > 0 ? '+' : ''}${d.change}%)` : ''
                return [`${v}%${chg} · ${d?.stance || ''}`, 'Repo rate']
              }}
            />
            <ReferenceLine y={policy.repoRate} stroke="var(--accent)" strokeDasharray="6 4" strokeOpacity={0.5} />
            <Line type="stepAfter" dataKey="rate" name="Repo rate" stroke="var(--accent)" strokeWidth={2} dot={{ r: 3, fill: 'var(--accent)' }} />
          </LineChart>
        ) : null}
      </ChartSection>

      {/* 2. CPI vs RBI target band */}
      <ChartSection title="CPI Inflation vs RBI Target Band" badge="Prices" source={inflation?.source || 'MOSPI via indiandataproject.org'}>
        {inflation?.series?.length ? (
          <LineChart data={inflation.series} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            {GRID}
            <XAxis dataKey="period" tick={tick} minTickGap={45} />
            <YAxis tick={tick} width={42} tickFormatter={v => `${v}%`} />
            <Tooltip {...TOOLTIP_PROPS} formatter={(v, name) => [fmtPct(v), name]} />
            <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
            <ReferenceArea y1={band.lower} y2={band.upper} fill="rgba(16,185,129,0.08)" stroke="none" />
            <ReferenceLine y={(band.lower + band.upper) / 2} stroke="rgba(16,185,129,0.5)" strokeDasharray="6 4" />
            <Line type="monotone" dataKey="cpiHeadline" name="Headline CPI" stroke="#38bdf8" strokeWidth={2} dot={false} connectNulls />
            <Line type="monotone" dataKey="cpiFood" name="Food CPI" stroke="#f59e0b" strokeWidth={1.5} dot={false} connectNulls />
            <Line type="monotone" dataKey="cpiCore" name="Core CPI" stroke="#a78bfa" strokeWidth={1.5} dot={false} connectNulls />
          </LineChart>
        ) : null}
      </ChartSection>

      {/* 3. Real GDP growth */}
      <ChartSection title="Real GDP Growth (annual)" badge="Growth" source={gdpGrowth?.source || 'MOSPI via indiandataproject.org'}>
        {gdpGrowth?.series?.length ? (
          <BarChart data={gdpGrowth.series} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            {GRID}
            <XAxis dataKey="year" tick={tick} minTickGap={20} />
            <YAxis tick={tick} width={42} tickFormatter={v => `${v}%`} />
            <Tooltip {...TOOLTIP_PROPS} formatter={(v) => [fmtPct(v), 'GDP growth']} />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" />
            <Bar dataKey="value" name="GDP growth">
              {gdpGrowth.series.map((d) => (
                <Cell key={d.year} fill={d.value >= 0 ? 'var(--success)' : 'var(--danger)'} fillOpacity={0.75} />
              ))}
            </Bar>
          </BarChart>
        ) : null}
      </ChartSection>

      {/* 4. External trade & CAD (% of GDP) */}
      <ChartSection title="External Trade & Current Account (% of GDP)" badge="External" source={external?.source || 'Economic Survey via indiandataproject.org'}>
        {external?.series?.length ? (
          <ComposedChart data={external.series} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            {GRID}
            <XAxis dataKey="year" tick={tick} />
            <YAxis tick={tick} width={42} tickFormatter={v => `${v}%`} />
            <Tooltip {...TOOLTIP_PROPS} formatter={(v, name) => [name === 'Forex reserves' ? `$${fmtNum(v)}B` : fmtPct(v), name]} />
            <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" />
            <Bar dataKey="exports" name="Exports" fill="#10b981" fillOpacity={0.7} />
            <Bar dataKey="imports" name="Imports" fill="#ef4444" fillOpacity={0.7} />
            <Line type="monotone" dataKey="tradeBalance" name="Trade balance" stroke="#f59e0b" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="cadPctGDP" name="CAD" stroke="#a78bfa" strokeWidth={2} strokeDasharray="6 4" dot={false} />
          </ComposedChart>
        ) : null}
      </ChartSection>

      {/* 5. Forex reserves */}
      <ChartSection title="Forex Reserves (last 20 years, USD billion)" badge="RBI" source={forex?.source || 'RBI via indiandataproject.org'}>
        {forex?.series?.length ? (
          <ComposedChart data={forex.series} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            {GRID}
            <XAxis dataKey="year" tick={tick} minTickGap={30} />
            <YAxis tick={tick} width={50} tickFormatter={v => `$${v}B`} />
            <Tooltip {...TOOLTIP_PROPS} formatter={(v) => [`$${fmtNum(v)}B`, 'Reserves']} />
            <Area type="monotone" dataKey="value" name="Reserves" stroke="var(--accent)" strokeWidth={2} fill="rgba(56,189,248,0.15)" />
          </ComposedChart>
        ) : null}
      </ChartSection>

      {/* 6. Fiscal deficits */}
      <ChartSection title="Fiscal Deficit Trends (% of GDP)" badge="Fiscal" source={fiscal?.source || 'Budget docs via indiandataproject.org'}>
        {fiscal?.series?.length ? (
          <LineChart data={fiscal.series} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            {GRID}
            <XAxis dataKey="year" tick={tick} />
            <YAxis tick={tick} width={42} tickFormatter={v => `${v}%`} />
            <Tooltip {...TOOLTIP_PROPS} formatter={(v, name) => [fmtPct(v), name]} />
            <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
            {fiscal.targetFiscalDeficit != null && (
              <ReferenceLine y={fiscal.targetFiscalDeficit} stroke="var(--success)" strokeDasharray="6 4" label={{ value: 'Target', fill: 'var(--success)', fontSize: 11, position: 'right' }} />
            )}
            <Line type="monotone" dataKey="fiscalDeficitPctGDP" name="Fiscal deficit" stroke="#38bdf8" strokeWidth={2} dot={{ r: 2.5 }} />
            <Line type="monotone" dataKey="revenueDeficitPctGDP" name="Revenue deficit" stroke="#f59e0b" strokeWidth={1.5} dot={false} />
            <Line type="monotone" dataKey="primaryDeficitPctGDP" name="Primary deficit" stroke="#a78bfa" strokeWidth={1.5} dot={false} />
          </LineChart>
        ) : null}
      </ChartSection>

      {/* 7. Sector growth + rates/liquidity, side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '1rem' }}>
        <ChartSection title="Sector Growth (GVA)" badge="Sectors" source={macro.sectorsSource || 'Economic Survey via indiandataproject.org'}>
          {sectors?.length ? (
            <BarChart data={sectors} layout="vertical" margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
              {GRID}
              <XAxis type="number" tick={tick} tickFormatter={v => `${v}%`} />
              <YAxis type="category" dataKey="name" tick={{ ...tick, fontSize: 10 }} width={130} />
              <Tooltip {...TOOLTIP_PROPS} formatter={(v, name, item) => [`${fmtPct(v)}${name === 'Current growth' && item?.payload?.gvaShare != null ? ` · ${item.payload.gvaShare}% of GVA` : ''}`, name]} />
              <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
              <Bar dataKey="currentGrowth" name="Current growth" fill="var(--accent)" fillOpacity={0.8} />
              <Bar dataKey="fiveYearAvg" name="5-yr avg" fill="#64748b" fillOpacity={0.7} />
            </BarChart>
          ) : null}
        </ChartSection>

        <ChartSection title="Bank Rates & Money Supply" badge="Liquidity" source="RBI / World Bank via indiandataproject.org">
          {ratesMerged.length ? (
            <LineChart data={ratesMerged} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              {GRID}
              <XAxis dataKey="year" tick={tick} minTickGap={30} />
              <YAxis tick={tick} width={42} tickFormatter={v => `${v}%`} />
              <Tooltip {...TOOLTIP_PROPS} formatter={(v, name) => [fmtPct(v), name]} />
              <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
              <Line type="monotone" dataKey="lending" name="Lending rate" stroke="#ef4444" strokeWidth={1.5} dot={false} connectNulls />
              <Line type="monotone" dataKey="deposit" name="Deposit rate" stroke="#10b981" strokeWidth={1.5} dot={false} connectNulls />
              <Line type="monotone" dataKey="m3" name="M3 growth" stroke="#38bdf8" strokeWidth={1.5} strokeDasharray="6 4" dot={false} connectNulls />
            </LineChart>
          ) : null}
        </ChartSection>
      </div>
    </div>
  )
}
