import { userPreferences } from '../lib/userSession'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchWithAbort } from '../hooks/useFetchWithAbort'
import {
  calculateRiskScenario,
  exceedsLimit,
  getScenarioExposure,
  normalizeOptionalLimit,
} from '../lib/portfolioRisk'
import './PortfolioRisk.css'
import MarketCapRisk from '../components/MarketCapRisk'
import { withMarketCapRisk } from '../lib/marketCapRisk'
import { loadMarketCapReference } from '../lib/marketCapReference'
import { sortRiskPositions } from '../lib/sortRiskPositions'
import { calculatePositionTrim } from '../lib/positionTrim'

const PREFERENCES_KEY = 'kite-portfolio-risk-preferences:v1'
const POSITION_COLUMNS = [
  { key: 'symbol', label: 'Holding' },
  { key: 'sector', label: 'Sector' },
  { key: 'marketCapCategory', label: 'Market cap' },
  { key: 'averageMarketCapCr', label: 'Company size (₹ Cr)', numeric: true },
  { key: 'quantity', label: 'Quantity', numeric: true },
  { key: 'currentValue', label: 'Current value', numeric: true },
  { key: 'weightPct', label: 'Allocation', numeric: true },
  { key: 'status', label: 'Status', numeric: true },
]

function readPreferences() {
  try {
    const parsed = JSON.parse(userPreferences.getItem(PREFERENCES_KEY) || '{}')
    return {
      stockLimit: parsed.stockLimit == null ? '' : String(parsed.stockLimit),
      sectorLimit: parsed.sectorLimit == null ? '' : String(parsed.sectorLimit),
      smallCapLimit: parsed.smallCapLimit == null ? '' : String(parsed.smallCapLimit),
      trimProceeds: parsed.trimProceeds === 'reinvest' ? 'reinvest' : 'cash',
    }
  } catch {
    return { stockLimit: '', sectorLimit: '', smallCapLimit: '', trimProceeds: 'cash' }
  }
}

const displayCategory = value => !value || value === 'Unknown' ? 'Others' : value

function formatCurrency(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

function formatPct(value) {
  return `${Number(value || 0).toFixed(2)}%`
}

function PortfolioTabs() {
  return (
    <nav className="portfolio-tabs" aria-label="Portfolio sections">
      <Link to="/portfolio">Equities</Link>
      <Link to="/portfolio?tab=mf">Mutual Funds</Link>
      <Link to="/portfolio/risk" className="active" aria-current="page">Risk</Link>
    </nav>
  )
}

function SummaryCard({ label, value, detail }) {
  return (
    <div className="glass-panel risk-summary-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  )
}

function LimitInput({ id, label, value, onChange }) {
  const normalizeOnBlur = () => {
    const normalized = normalizeOptionalLimit(value)
    onChange(normalized == null ? '' : String(normalized))
  }
  return (
    <label className="risk-limit-field" htmlFor={id}>
      <span>{label}</span>
      <div>
        <input
          id={id}
          type="number"
          min="0"
          max="100"
          step="1"
          value={value}
          placeholder="Unset"
          onChange={event => onChange(event.target.value)}
          onBlur={normalizeOnBlur}
        />
        <span>%</span>
      </div>
    </label>
  )
}

function PortfolioRisk() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState({ key: 'weightPct', direction: 'desc' })
  const [preferences, setPreferences] = useState(readPreferences)
  const [scenarioTarget, setScenarioTarget] = useState('portfolio')
  const [declinePct, setDeclinePct] = useState('10')
  const abortRef = useRef(null)

  const load = useCallback(async ({ refresh = false } = {}) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    if (refresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const endpoint = refresh ? '/api/portfolio-risk?refresh=1' : '/api/portfolio-risk'
      const response = await fetchWithAbort(endpoint, {
        signal: controller.signal,
        timeoutMs: 20_000,
      })
      let payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Failed to load portfolio risk data')
      if (payload.marketCapitalization?.status !== 'available' && payload.positions?.length) {
        try { payload = withMarketCapRisk(payload, await loadMarketCapReference()) } catch { /* Keep stock/sector analysis usable if public reference is unavailable. */ }
      }
      if (!controller.signal.aborted) setData(payload)
    } catch (err) {
      if (err.name === 'AbortError') return
      if (err.name === 'RateLimitedError') {
        setError(`Broker rate limit reached. Try again in ${Math.max(1, Math.ceil((err.retryAfter || 1000) / 1000))} seconds.`)
      } else {
        setError(err.message || 'Failed to load portfolio risk data')
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    load()
    return () => abortRef.current?.abort()
  }, [load])

  useEffect(() => {
    const stockLimit = normalizeOptionalLimit(preferences.stockLimit)
    const sectorLimit = normalizeOptionalLimit(preferences.sectorLimit)
    const smallCapLimit = normalizeOptionalLimit(preferences.smallCapLimit)
    try {
      userPreferences.setItem(PREFERENCES_KEY, JSON.stringify({ stockLimit, sectorLimit, smallCapLimit, trimProceeds: preferences.trimProceeds }))
    } catch {
      // Preferences remain usable for this session when storage is unavailable.
    }
  }, [preferences])

  useEffect(() => {
    if (!data || scenarioTarget === 'portfolio') return
    const exists = scenarioTarget.startsWith('market-cap:')
      ? data.marketCapitalization?.groups?.some(item => `market-cap:${item.category}` === scenarioTarget)
      : scenarioTarget.startsWith('sector:')
      ? data.sectors?.some(item => `sector:${item.sector}` === scenarioTarget)
      : data.positions?.some(item => `holding:${item.key}` === scenarioTarget)
    if (!exists) setScenarioTarget('portfolio')
  }, [data, scenarioTarget])

  const stockLimit = normalizeOptionalLimit(preferences.stockLimit)
  const sectorLimit = normalizeOptionalLimit(preferences.sectorLimit)
  const filteredPositions = useMemo(() => {
    const query = search.trim().toLowerCase()
    const positions = query ? (data?.positions || []).filter(item =>
      item.symbol.toLowerCase().includes(query) || displayCategory(item.sector).toLowerCase().includes(query) || displayCategory(item.marketCapCategory).toLowerCase().includes(query)
    ) : data?.positions || []
    return sortRiskPositions(positions, sort.key, sort.direction, stockLimit)
  }, [data, search, sort, stockLimit])

  const scenario = useMemo(() => calculateRiskScenario({
    coveredValue: data?.summary?.coveredValue,
    affectedExposure: getScenarioExposure(data, scenarioTarget),
    declinePct,
  }), [data, scenarioTarget, declinePct])

  if (loading) {
    return <div className="dashboard-layout"><PortfolioTabs /><div className="loader" /><p className="risk-centered">Building portfolio exposure…</p></div>
  }

  if (error && !data) {
    return (
      <div className="dashboard-layout">
        <PortfolioTabs />
        <div className="glass-panel risk-state">
          <h2>Portfolio risk is unavailable</h2>
          <p>{error}</p>
          <button className="risk-primary-button" onClick={() => load()}>Retry</button>
        </div>
      </div>
    )
  }

  const noHoldings = data?.coverage?.totalHoldingCount === 0
  const noCoveredValue = !noHoldings && data?.summary?.coveredValue === 0
  const largestPosition = data?.summary?.largestPosition
  const largestSector = data?.summary?.largestClassifiedSector

  return (
    <div className="dashboard-layout portfolio-risk-page">
      <div className="risk-toolbar">
        <PortfolioTabs />
        <button className="risk-refresh-button" onClick={() => load({ refresh: true })} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="risk-heading">
        <div>
          <h1>Portfolio Risk</h1>
          <p>Stock, sector and company-size concentration across your equity holdings.</p>
        </div>
        {data?.holdingsFetchedAt && (
          <span>Holdings fetched at {new Date(data.holdingsFetchedAt).toLocaleString('en-IN')}</span>
        )}
      </div>

      {error && <div className="risk-banner error" role="alert">Refresh failed: {error}. Showing the last successful result.</div>}
      {noHoldings && (
        <div className="glass-panel risk-state">
          <h2>No equity holdings</h2>
          <p>Your portfolio risk view will appear after an equity holding is available.</p>
        </div>
      )}
      {noCoveredValue && (
        <div className="glass-panel risk-state">
          <h2>No priced holdings</h2>
          <p>{data.coverage.unpricedHoldingCount} holding(s) could not be valued. Refresh when current prices are available.</p>
        </div>
      )}

      {!noHoldings && !noCoveredValue && (
        <>
          {(data.coverage.unpricedHoldingCount > 0 || data.coverage.classificationCoveragePct < 100) && (
            <div className="risk-banner" role="status">
              <strong>Partial coverage.</strong>{' '}
              {data.coverage.unpricedHoldingCount > 0 && `${data.coverage.unpricedHoldingCount} holding(s) have no valid price and are excluded from covered value. `}
              Sector classification covers {formatPct(data.coverage.classificationCoveragePct)} of covered value; the remainder is shown as Others.
            </div>
          )}

          <section className="risk-summary-grid" aria-label="Portfolio risk summary">
            <SummaryCard label="Covered equity value" value={formatCurrency(data.summary.coveredValue)} detail={`${data.coverage.valuedHoldingCount} valued holdings`} />
            <SummaryCard label="Largest position" value={largestPosition?.symbol || '—'} detail={largestPosition ? `${formatPct(largestPosition.weightPct)} · ${formatCurrency(largestPosition.currentValue)}` : null} />
            <SummaryCard label="Top five allocation" value={formatPct(data.summary.topFiveWeightPct)} detail="of covered equity value" />
            <SummaryCard label="Largest classified sector" value={largestSector?.sector || '—'} detail={largestSector ? `${formatPct(largestSector.weightPct)} · ${formatCurrency(largestSector.currentValue)}` : 'No classified exposure'} />
          </section>

          <MarketCapRisk data={data} smallCapLimit={normalizeOptionalLimit(preferences.smallCapLimit)} onScenario={category => { setScenarioTarget(`market-cap:${category}`); document.getElementById('scenario-target')?.focus() }} />

          <section className="glass-panel risk-limits-panel">
            <div>
              <h2>Concentration limits</h2>
              <p>Optional guideposts. An allocation is flagged only when it is above the limit.</p>
            </div>
            <div className="risk-limit-fields">
              <LimitInput id="stock-limit" label="Maximum stock allocation" value={preferences.stockLimit} onChange={value => setPreferences(current => ({ ...current, stockLimit: value }))} />
              <LimitInput id="sector-limit" label="Maximum sector allocation" value={preferences.sectorLimit} onChange={value => setPreferences(current => ({ ...current, sectorLimit: value }))} />
              <LimitInput id="small-cap-limit" label="Maximum small-cap allocation" value={preferences.smallCapLimit} onChange={value => setPreferences(current => ({ ...current, smallCapLimit: value }))} />
              <label className="risk-trim-mode" htmlFor="risk-trim-proceeds"><span>Sale proceeds</span><select id="risk-trim-proceeds" value={preferences.trimProceeds || 'cash'} onChange={event => setPreferences(current => ({ ...current, trimProceeds: event.target.value }))}><option value="cash">Keep as cash</option><option value="reinvest">Reinvest in other equities</option></select></label>
            </div>
          </section>

          <div className="risk-two-column">
            <section className="glass-panel">
              <div className="risk-section-heading">
                <div><h2>Sector exposure</h2><p>Share of covered equity value</p></div>
                <span>{formatPct(data.coverage.classificationCoveragePct)} classified</span>
              </div>
              <div className="sector-exposure-list">
                {data.sectors.map((sector, index) => {
                  const breached = sector.sector !== 'Unknown' && exceedsLimit(sector.weightPct, sectorLimit)
                  return (
                    <div className="sector-exposure-row" key={sector.sector}>
                      <div className="sector-exposure-label">
                        <strong>{displayCategory(sector.sector)}</strong>
                        <span>{sector.holdingCount} holding{sector.holdingCount === 1 ? '' : 's'} · {formatCurrency(sector.currentValue)}</span>
                      </div>
                      <div className="sector-exposure-value">
                        <span>{formatPct(sector.weightPct)}</span>
                        {breached && <span className="risk-badge">Above limit</span>}
                      </div>
                      <div className="sector-bar-track" aria-hidden="true">
                        <div className={`sector-bar-fill sector-color-${index % 5}`} style={{ width: `${Math.min(100, sector.weightPct)}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>

            <section className="glass-panel risk-scenario-panel">
              <div className="risk-section-heading">
                <div><h2>Loss scenario</h2><p>Illustrative only; scenarios do not stack.</p></div>
                <span className="risk-hypothetical-label">Hypothetical</span>
              </div>
              <label htmlFor="scenario-target">Apply decline to</label>
              <select id="scenario-target" value={scenarioTarget} onChange={event => setScenarioTarget(event.target.value)}>
                <option value="portfolio">Whole portfolio</option>
                <optgroup label="Market-cap categories">
                  {(data.marketCapitalization?.groups || []).filter(item => item.currentValue > 0).map(item => <option key={item.category} value={`market-cap:${item.category}`}>{displayCategory(item.category)}</option>)}
                </optgroup>
                <optgroup label="Sectors">
                  {data.sectors.map(item => <option key={item.sector} value={`sector:${item.sector}`}>{displayCategory(item.sector)}</option>)}
                </optgroup>
                <optgroup label="Holdings">
                  {data.positions.map(item => <option key={item.key} value={`holding:${item.key}`}>{item.symbol}</option>)}
                </optgroup>
              </select>
              <label htmlFor="scenario-decline">Illustrative decline</label>
              <div className="risk-decline-control">
                <input id="scenario-decline" type="range" min="0" max="100" step="1" value={scenario.declinePct} onChange={event => setDeclinePct(event.target.value)} />
                <div><input aria-label="Illustrative decline percentage" type="number" min="0" max="100" value={declinePct} onChange={event => setDeclinePct(event.target.value)} onBlur={() => setDeclinePct(String(scenario.declinePct))} /><span>%</span></div>
              </div>
              <div className="risk-scenario-results">
                <div><span>Affected exposure</span><strong>{formatCurrency(scenario.affectedExposure)}</strong></div>
                <div><span>Hypothetical loss</span><strong className="negative">−{formatCurrency(scenario.hypotheticalLoss)}</strong></div>
                <div><span>Portfolio loss</span><strong className="negative">−{formatPct(scenario.portfolioLossPct)}</strong></div>
                <div><span>Resulting covered value</span><strong>{formatCurrency(scenario.resultingValue)}</strong></div>
              </div>
            </section>
          </div>

          <section className="glass-panel risk-holdings-panel">
            <div className="risk-section-heading risk-holdings-heading">
              <div><h2>Position concentration</h2><p>Click a column heading to sort. Allocations always use the complete covered portfolio.</p></div>
              <label htmlFor="risk-search" className="visually-labeled-input">
                <span>Filter holdings</span>
                <input id="risk-search" type="search" placeholder="Symbol, sector or market cap" value={search} onChange={event => setSearch(event.target.value)} />
              </label>
            </div>
            <p className="risk-trim-method">{preferences.trimProceeds !== 'reinvest' ? 'Sell estimates keep proceeds as cash, so the covered equity total also falls.' : 'Sell estimates assume all proceeds are reinvested in other equities, keeping the covered equity total unchanged.'} Each row is a separate estimate; refresh after any sale. Quantities round up to whole shares where possible, using each holding’s valuation price. Confirm live price and sellable quantity before placing an order.</p>
            <div className="risk-table-wrap">
              <table className="interactive-table risk-table">
                <thead><tr>{POSITION_COLUMNS.map(column => {
                  const active = sort.key === column.key
                  return <th key={column.key} scope="col" aria-sort={active ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button type="button" className={`risk-sort-button ${active ? 'active' : ''}`} onClick={() => setSort(current => ({ key: column.key, direction: current.key === column.key ? current.direction === 'asc' ? 'desc' : 'asc' : column.numeric ? 'desc' : 'asc' }))}>{column.label} <span aria-hidden="true">{active ? sort.direction === 'asc' ? '↑' : '↓' : '↕'}</span></button></th>
                })}</tr></thead>
                <tbody>
                  {filteredPositions.map(position => {
                    const breached = exceedsLimit(position.weightPct, stockLimit)
                    const trim = calculatePositionTrim({ currentValue: position.currentValue, coveredValue: data.summary.coveredValue, quantity: position.quantity, limit: stockLimit, proceeds: preferences.trimProceeds })
                    return (
                      <tr key={position.key}>
                        <td>{position.instrumentToken ? <Link to={`/instrument/${position.instrumentToken}?symbol=${encodeURIComponent(position.symbol)}`}>{position.symbol}</Link> : <strong>{position.symbol}</strong>}<small>{position.exchange}</small></td>
                        <td>{displayCategory(position.sector)}</td>
                        <td><strong>{displayCategory(position.marketCapCategory)}</strong>{position.marketCapRank && <small className="risk-cap-position-note">AMFI rank {position.marketCapRank}</small>}</td>
                        <td title="Six-month average company market capitalization from the AMFI classification list">{Number.isFinite(position.averageMarketCapCr) ? position.averageMarketCapCr.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—'}</td>
                        <td>{position.quantity.toLocaleString('en-IN', { maximumFractionDigits: 4 })}</td>
                        <td>{formatCurrency(position.currentValue)}</td>
                        <td><strong>{formatPct(position.weightPct)}</strong></td>
                        <td>{breached
                          ? <div className="risk-trim-result"><span className="risk-badge">Above stock limit</span>{trim ? <><strong>Sell ≈ {trim.quantityToSell.toLocaleString('en-IN', { maximumFractionDigits: 4 })} shares</strong><span>Estimated value {formatCurrency(trim.estimatedProceeds)}</span><small>Allocation after sale: {formatPct(trim.remainingWeightPct)} · target {formatPct(trim.targetPct)}</small></> : <small>Sale estimate unavailable</small>}</div>
                          : <span className="risk-within-limit">{stockLimit === null ? 'No limit set' : 'Within limit'}</span>}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {filteredPositions.length === 0 && <p className="risk-empty-filter">No holdings match “{search}”.</p>}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

export default PortfolioRisk
