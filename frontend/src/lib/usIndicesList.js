// ─── The US Indices page's rows ──────────────────────────────────────────────
//
// Data only, so a test can hold the one rule that kept breaking silently: the
// sector rows here, the RRG universe the backend serves (backend/rrg/
// universe.js, also read by GET /api/us/rrg) and the weekly RRG recorder must
// be the same list. A row added here and not there plots on the chart but is
// never recorded. See usIndicesList.test.js.

export const INDICES = [
  { key: "SPY", name: "S&P 500", category: "broad" },
  { key: "QQQ", name: "Nasdaq 100", category: "broad" },
  { key: "DIA", name: "Dow 30", category: "broad" },
  { key: "IWM", name: "Russell 2000", category: "broad" },
  { key: "VTI", name: "Total Market", category: "broad" },
  { key: "RSP", name: "S&P 500 Equal Wt", category: "broad" },
  { key: "MDY", name: "S&P MidCap 400", category: "broad" },
  { key: "IJR", name: "S&P SmallCap 600", category: "broad" },
  { key: "IWB", name: "Russell 1000", category: "broad" },
  { key: "XLK", name: "Technology", category: "sector" },
  { key: "XLF", name: "Financials", category: "sector" },
  { key: "XLV", name: "Health Care", category: "sector" },
  { key: "XLY", name: "Consumer Discretionary", category: "sector" },
  { key: "XLP", name: "Consumer Staples", category: "sector" },
  { key: "XLE", name: "Energy", category: "sector" },
  { key: "XLI", name: "Industrials", category: "sector" },
  { key: "XLB", name: "Materials", category: "sector" },
  { key: "XLRE", name: "Real Estate", category: "sector" },
  { key: "XLU", name: "Utilities", category: "sector" },
  { key: "XLC", name: "Communication Services", category: "sector" },
  { key: "SMH", name: "Semiconductors", category: "sector" },
  { key: "XBI", name: "Biotech", category: "sector" },
  { key: "KRE", name: "Regional Banks", category: "sector" },
  { key: "ITB", name: "Homebuilders", category: "sector" },
  { key: "XOP", name: "Oil & Gas E&P", category: "sector" },
  { key: "XRT", name: "Retail", category: "sector" },
  { key: "IYT", name: "Transports", category: "sector" },
  { key: "GLD", name: "Gold ETF (GLD)", category: "sector" },
  { key: "GDX", name: "Gold Miners", category: "sector" },
  { key: "IGV", name: "Software", category: "sector" },
  // ─── Thematic rows ─────────────────────────────────────────────────────────
  // Every row above is an ETF standing in for a sector, which is exact enough
  // for the GICS ones (XLK holds the S&P 500's Information Technology members,
  // no more). These are looser, and worth being explicit about: GICS has no
  // "cybersecurity", "quantum" or "space" sector, so each theme exists only as
  // somebody's index definition and the fund IS the definition here.
  //
  // Two rules picked each proxy, and both were measured against this app's own
  // /api/us/historical-full rather than assumed:
  //
  //   1. Prefer an index-tracking fund to an actively managed one. ARKX was the
  //      obvious space candidate and was rejected for exactly this: its holdings
  //      are ARK's current picks, so "how did space do" would partly mean "how
  //      did ARK pick". UFO tracks the S-Network Space Index instead. (ROKT
  //      tracks an index too, but trades ~30k shares/day and its index covers
  //      deep sea alongside space.)
  //   2. Prefer the liquid fund. A thin fund's prints are its own spread as much
  //      as the theme's move, and thin funds skip sessions outright — HDRO, the
  //      other hydrogen ETF, has 678 daily bars where every other fund here has
  //      1003 over the same span. A return series with 325 missing days is not a
  //      cheaper version of the same measurement.
  //
  //   CIBR  Cybersecurity      First Trust Nasdaq CEA   ~1.36M sh/day (HACK 232k)
  //   UFO   Space              Procure / S-Network      ~479k
  //   ITA   Aerospace-defence  iShares US A&D           ~$161M/day (PPA $31M)
  //   QTUM  Quantum computing  Defiance                 ~$61M/day
  //   HYDR  Hydrogen           Global X                 ~$3M/day — the thinnest
  //   REMX  Rare earth metals  VanEck                   ~$58M/day
  //   URA   Uranium            Global X                 ~$141M/day (URNM $20M)
  //   ICLN  Clean energy       iShares / S&P Global     ~$112M/day (TAN $59M, PBW $11M,
  //                            Clean Energy Transition             QCLN $6M, CNRG $1M)
  //
  // All eight carry the full 1003 bars, so every column on this page including
  // 3Y is computed rather than interpolated. None is a pure-play read: a space
  // or defence index necessarily holds names that earn most of their revenue
  // elsewhere, and the rare-earth and uranium funds are miner baskets, which
  // track the commodity with leverage and their own operational risk on top.
  { key: "CIBR", name: "Cybersecurity", category: "sector" },
  { key: "UFO", name: "Space Technology", category: "sector" },
  { key: "ITA", name: "Aerospace & Defence", category: "sector" },
  // Named for what it tracks, not what it is nicknamed. QTUM follows the
  // BlueStar Machine Learning AND Quantum Computing Index, whose stated criteria
  // include "embedded artificial intelligence chips" and big-data software —
  // which is why Arm and Alibaba are members. It is near equal-weight (every
  // position 0.26%-2.03%), so those are not a rounding tail: Alibaba at 1.22%
  // outweighs IonQ at 0.89%. Calling the row "Quantum Computing" promised a
  // read this fund does not deliver.
  { key: "QTUM", name: "Quantum & Machine Learning", category: "sector" },
  // The purer read, and much younger. WisdomTree's fund holds the pure-plays
  // (QNT, QBTS, RGTI, IONQ) ahead of the large-cap names. Chosen over QTUP,
  // which is purer still but 46 trading days old and trades ~$1M/day, and over
  // CQTM at under $1M/day; the 2x daily funds (XQTM, QPUX) are excluded on
  // principle, since a leveraged daily-reset product does not represent a
  // theme's return over any horizon this page reports.
  //
  // 212 bars means 1Y, 2Y and 3Y cannot be computed and now render as dashes
  // rather than as a since-inception number wearing a longer label. Those fill
  // in as the fund ages.
  { key: "WQTM", name: "Quantum Computing (pure)", category: "sector" },
  { key: "HYDR", name: "Hydrogen Energy", category: "sector" },
  { key: "REMX", name: "Rare Earth Metals", category: "sector" },
  { key: "URA", name: "Uranium", category: "sector" },
  // A global index, so its drilldown is the thin part. ICLN holds ~100 names
  // and roughly half are European and Asian utilities and turbine makers
  // (Vestas, Iberdrola, Orsted…) that trade in the US only over the counter,
  // where Alpaca cannot price them; the Stocks tab shows the US-listed slice
  // (First Solar, Nextracker, Bloom, Enphase, Ormat…), 9 names as measured on
  // 2026-11-14. The row's own returns are the fund's and are complete. QCLN
  // would drill into ~23 US names, but it trades ~$6M/day against ICLN's
  // ~$112M and is weighted toward Tesla, Rivian and analog chips, so "how did
  // clean energy do" would partly read "how did Tesla do". TAN is solar only.
  { key: "ICLN", name: "Clean Energy", category: "sector" },
];

// Keep rotation coverage aligned with the visible list. WQTM still lacks the
// multi-quarter history required by the existing RRG universe.
export const US_RRG_KEYS = INDICES.filter(row => row.category === 'sector' && row.key !== 'WQTM').map(row => row.key)
export const US_RRG_SECURITIES = US_RRG_KEYS.join(',')
