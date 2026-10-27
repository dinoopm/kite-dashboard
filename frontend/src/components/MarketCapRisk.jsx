import { exceedsLimit } from '../lib/portfolioRisk'

const TYPES = [
  { category: 'Large Cap', label: 'Large cap', range: 'AMFI ranks 1–100', risk: 'Relatively lower size risk', className: 'large', explanation: 'Typically larger, established businesses. Company-specific and market losses still apply.' },
  { category: 'Mid Cap', label: 'Mid cap', range: 'AMFI ranks 101–250', risk: 'Elevated size risk', className: 'mid', explanation: 'Greater exposure to business-cycle, funding and trading-liquidity pressures than larger companies.' },
  { category: 'Small Cap', label: 'Small cap', range: 'AMFI ranks 251 onward', risk: 'Higher size risk', className: 'small', explanation: 'Smaller companies can be more sensitive to financing shocks, price swings and difficulty selling.' },
  { category: 'Unknown', label: 'Others', range: 'No matching AMFI classification', risk: 'Size risk unassessed', className: 'unknown', explanation: 'Unmatched securities, ETFs and other instruments remain here; they are not assumed to be small caps.' },
]
const pct = value => `${Number(value || 0).toFixed(2)}%`
const money = value => `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const date = value => value ? new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'Unavailable'

export default function MarketCapRisk({ data, smallCapLimit, onScenario }) {
  const cap = data?.marketCapitalization
  const groups = TYPES.map(type => ({ ...type, ...(cap?.groups?.find(item => item.category === type.category) || { currentValue: 0, weightPct: 0, holdingCount: 0 }) }))
  const unknown = groups[3]
  const small = groups[2]
  const breached = exceedsLimit(small.weightPct, smallCapLimit)
  const dominant = [...groups.slice(0, 3)].sort((a, b) => b.currentValue - a.currentValue)[0]
  const available = cap?.status === 'available'
  const expectedPeriod = new Date().getUTCMonth() >= 7 ? `${new Date().getUTCFullYear()}-06-30` : `${new Date().getUTCFullYear() - 1}-12-31`
  const olderList = cap?.periodEnd && cap.periodEnd < expectedPeriod
  const title = !available || !dominant.currentValue ? 'Company-size risk is unassessed' : breached ? 'Small-cap allocation is above your limit' : `${dominant.label}-led ${unknown.weightPct > 0 ? 'classified allocation' : 'portfolio'}`
  return <section className="glass-panel risk-market-cap" aria-labelledby="risk-market-cap-title">
    <div className="risk-section-heading"><div><h2 id="risk-market-cap-title">Market-cap risk</h2><p>Company size determines the category; your holding value determines the allocation.</p></div><span>{pct(cap?.classificationCoveragePct)} of covered value classified</span></div>
    <div className={`risk-cap-summary ${breached ? 'risk-cap-over-limit' : ''}`}>
      <div><h3>{title}</h3><p>{available ? <><strong>{pct(cap.midSmallWeightPct)}</strong> in mid and small caps combined. <strong>{pct(small.weightPct)}</strong> in small caps.{unknown.weightPct > 0 && <> Another <strong>{pct(unknown.weightPct)}</strong> has no size classification.</>}</> : 'Market-cap data is unavailable. Refresh after the updated server is active; existing stock and sector analysis remains available.'}</p></div>
      {breached && <span className="risk-badge">Above {pct(smallCapLimit)} small-cap limit</span>}
    </div>
    {available && <>
      <div className="risk-cap-allocation" role="img" aria-label={groups.map(group => `${group.label}: ${pct(group.weightPct)}`).join('; ')}>{groups.filter(group => group.weightPct > 0).map(group => <span key={group.category} className={`risk-cap-segment cap-${group.className}`} style={{ width: `${group.weightPct}%` }} title={`${group.label}: ${pct(group.weightPct)}`} />)}</div>
      <div className="risk-cap-grid">{groups.map(group => <article className={`risk-cap-card cap-${group.className}`} key={group.category}>
        <div className="risk-cap-card-heading"><h3>{group.label}</h3><span>{group.holdingCount} holding{group.holdingCount === 1 ? '' : 's'}</span></div>
        <strong className="risk-cap-weight">{pct(group.weightPct)}</strong><span className="risk-cap-value">{money(group.currentValue)}</span>
        <span className="risk-cap-rank">{group.range}</span><h4>{group.risk}</h4><p>{group.explanation}</p>
        {group.currentValue > 0 && <button type="button" className="risk-refresh-button" onClick={() => onScenario(group.category)}>Model a decline</button>}
      </article>)}</div>
    </>}
    {(unknown.weightPct > 0 || olderList) && <p className="risk-cap-coverage" role="status">{unknown.weightPct > 0 && `${pct(unknown.weightPct)} of covered value is unclassified. A partial profile may understate mid- and small-cap exposure. `}{olderList && 'A newer half-year classification may be due; the reference period below is older than expected.'}</p>}
    <p className="risk-cap-method">AMFI classifies companies by six-month average full market capitalization. Reference period ended <strong>{date(cap?.periodEnd)}</strong>. {cap?.fetchedAt && <>Reference fetched {date(cap.fetchedAt)}. </>}Allocation includes Others in the denominator and excludes unpriced holdings. This is a size-exposure assessment; company size alone does not measure total portfolio risk. <a href={cap?.sourceUrl || 'https://www.amfiindia.com/otherdata/categorisation-of-stocks'} target="_blank" rel="noopener noreferrer">AMFI source ↗</a></p>
  </section>
}
