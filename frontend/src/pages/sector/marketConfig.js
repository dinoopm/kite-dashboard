// Per-market configuration for the shared sector drill-down.
//
// SectorDetail (India) and UsSectorDetail (US) were near-identical copies —
// ~1200 lines each, differing only in the values below. The copies drifted:
// fixes landed on one file and not the other. Everything that genuinely
// differs between the two markets now lives here, so the page itself has a
// single implementation.

// ETF tickers are opaque, so the US drill-down maps them to readable names.
//
// This duplicates US_LABELS in backend/alpaca.js, and the duplication has a
// cost worth knowing: the seven thematic rows were added and renamed on the
// backend only, so their drill-downs kept showing the bare ticker until this
// copy caught up. The page now prefers the name the API returns, which makes
// the backend authoritative; this map is the pre-fetch fallback, used for the
// breadcrumb and the "Loading …" line before the response lands.
const US_LABELS = {
  SPY: 'S&P 500', QQQ: 'Nasdaq 100', DIA: 'Dow 30', IWM: 'Russell 2000',
  VTI: 'Total Market', RSP: 'S&P 500 Equal Wt', MDY: 'S&P MidCap 400',
  IJR: 'S&P SmallCap 600', IWB: 'Russell 1000',
  XLK: 'Technology', XLF: 'Financials', XLV: 'Health Care',
  XLY: 'Consumer Discretionary', XLP: 'Consumer Staples', XLE: 'Energy',
  XLI: 'Industrials', XLB: 'Materials', XLRE: 'Real Estate', XLU: 'Utilities',
  XLC: 'Communication Services', SMH: 'Semiconductors', XBI: 'Biotech',
  KRE: 'Regional Banks', ITB: 'Homebuilders', XOP: 'Oil & Gas E&P',
  XRT: 'Retail', IYT: 'Transports', GDX: 'Gold Miners', IGV: 'Software',
  CIBR: 'Cybersecurity', UFO: 'Space Technology', ITA: 'Aerospace & Defence',
  QTUM: 'Quantum & Machine Learning', WQTM: 'Quantum Computing (pure)',
  HYDR: 'Hydrogen Energy', REMX: 'Rare Earth Metals', URA: 'Uranium',
};

export const INDIA_MARKET = {
  id: 'india',
  // Route segment inserted after /api — India endpoints are unprefixed.
  apiPrefix: '',
  benchmarkKey: 'NSE:NIFTY 50',
  benchmarkLabel: 'NIFTY 50',
  currency: '₹',
  locale: 'en-IN',
  indicesRoute: '/indices',
  // "NSE:NIFTY PHARMA" → "NIFTY PHARMA"
  sectorNameFor: (key) => key.split(':')[1] || key,
  instrumentHref: (s) => `/instrument/${s.token}?symbol=${encodeURIComponent(s.symbol)}`,
  // Technical Alerts is backed by /api/sector-alerts, which is India-only.
  hasAlertsTab: true,
  rrgExtraProps: () => ({}),
};

export const US_MARKET = {
  id: 'us',
  apiPrefix: '/us',
  benchmarkKey: 'SPY',
  benchmarkLabel: 'SPY',
  currency: '$',
  locale: 'en-US',
  indicesRoute: '/us',
  sectorNameFor: (key) => US_LABELS[key] || key,
  instrumentHref: (s) => `/us/${encodeURIComponent(s.token)}`,
  // No /api/us/sector-alerts endpoint exists, so the tab stays hidden.
  hasAlertsTab: false,
  // Alpaca answers 100 symbols of daily bars in one request, so the drill-down
  // does not have to walk an index one stock at a time. India has no equivalent
  // bulk endpoint, so it keeps the per-symbol path.
  batchHistoryPath: '/us/historical-batch',
  // US sector keys are plain tickers, so the RRG can link straight to them
  // and needs no name shortening.
  rrgExtraProps: (constituents) => ({
    getNavHref: (sector) => `/us/${encodeURIComponent(sector.key)}`,
    shortNameFn: (name) => name,
    defaultVisibleKeys: constituents.map(c => c.key),
    subtitleFn: subtitleFromConstituents(constituents),
  }),
};
