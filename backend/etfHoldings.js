// Live ETF holdings for the US drilldown ("Stocks" tab). Replaces the curated
// 10-name stubs in alpaca.js with each fund's actual membership.
//
// Sources, by issuer:
//   • SPDR / State Street (XBI, KRE, XOP, XRT, DIA, …) — full daily-holdings
//     xlsx. Returns the complete membership (e.g. XBI ≈ 150 names).
//   • Defiance (QTUM), First Trust (CIBR), Global X (URA, HYDR) and Procure
//     (UFO) — the issuer's own full-holdings page, parsed per issuer below.
//   • Everyone else (VanEck SMH/GDX/REMX, iShares ITB/IYT/IGV/ITA, …) —
//     StockAnalysis.com. iShares/VanEck sit behind Akamai bot-management, so
//     their own CSV/ajax endpoints can't be fetched server-side (even via a
//     headless browser the full list comes from a blocked ajax call);
//     StockAnalysis is the reliable uniform source, but its free tier caps at
//     the top ~25 by weight, so those funds' drilldowns remain partial.
//
// 24h in-memory cache + in-flight coalescing, mirroring usUniverses.js. On any
// failure the caller falls back to the curated US_CONSTITUENTS stub.
const fflate = require('fflate');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const TTL = 24 * 60 * 60 * 1000;
const cache = {};    // sym -> { data, ts }
const inflight = {}; // sym -> Promise

// SPDR funds resolvable from State Street's public daily-holdings xlsx.
const SSGA_FUNDS = new Set(['XBI', 'KRE', 'XOP', 'XRT', 'DIA']);

// StockAnalysis tags non-US-primary listings with the home exchange
// ("!tsx/AEM"), and the segment after the slash is the HOME ticker, not the US
// one. For many dual-listed names they coincide (AEM, WPM, FNV, PAAS…), so the
// default is to use that segment — but where they differ, or where the name has
// no US exchange listing at all (OTC-only), Alpaca can't price it and the row
// would render as "–" / 0.00%. This map fixes the known offenders: value is the
// US ticker, null means drop the row. Same treatment for German-listed ADR rows
// ("EDG.DE") whose real US ADR trades under another symbol.
const FOREIGN_US_MAP = {
  'TSX/K': 'KGC',    // Kinross Gold
  'TSX/ABX': 'B',    // Barrick Mining
  'TSX/IMG': 'IAG',  // IAMGOLD
  'TSX/ELD': 'EGO',  // Eldorado Gold
  'TSX/LUG': null,   // Lundin Gold — OTC only (LUGDF)
  'TSX/DPM': null,   // DPM Metals — OTC only (DPMLF)
  'TSX/EDV': null,   // Endeavour Mining — OTC only (EDVMF)
  'ASX/NST': null,   // Northern Star Resources — OTC only (NESRF)
  'ASX/EVN': null,   // Evolution Mining — OTC only (CAHPF)
  'LON/FRES': null,  // Fresnillo — OTC only (FNLPF)
  'EDG.DE': 'GFI',   // Gold Fields ADR
  'HAM.DE': 'HMY',   // Harmony Gold ADR

  // Global X's CSVs use Bloomberg tickers, so foreign lines read "CCO CN"
  // (exchange after a space) rather than "TSX/CCO". Only entries whose US line
  // was confirmed by name are listed — the country code is NOT stripped
  // programmatically, because "CCO" alone is Clear Channel Outdoor and a
  // generated ticker that prices successfully while naming the wrong company is
  // worse than a missing row.
  //
  // This matters most on URA, where Cameco alone is 22.3% of the fund and was
  // being dropped by both sources, so the drilldown silently omitted its
  // largest position.
  'CCO CN': 'CCJ',   // Cameco
  'NXE CN': 'NXE',   // NexGen Energy
  'EFR CN': 'UUUU',  // Energy Fuels
  'DML CN': 'DNN',   // Denison Mines
  'BHP AU': 'BHP',   // BHP Group ADR
  'SSW SJ': 'SBSW',  // Sibanye Stillwater ADR
  '7203 JP': 'TM',   // Toyota Motor ADR
  // Considered and deliberately dropped: no ordinary US listing to price.
  'U-U CN': null,    // Sprott Physical Uranium Trust — OTC only (SRUUF)
  'KAP LI': null,    // Kazatomprom — London GDR
  'YCA LN': null,    // Yellow Cake — London only
};

// Normalize to a ticker Alpaca can price: letters with an optional dot class
// (BRK.B). Cash/derivative rows fail the test → dropped.
const cleanSymbol = (raw) => {
  let s = (raw || '').replace(/^[$!]/, '').trim().toUpperCase();
  if (s in FOREIGN_US_MAP) return FOREIGN_US_MAP[s];
  if (s.includes('/')) s = s.split('/').pop(); // "TSX/AEM" -> "AEM"
  return /^[A-Z]{1,6}(\.[A-Z])?$/.test(s) ? s : null;
};

// ─── SPDR / State Street: full holdings from the daily xlsx ──────────────────
async function fetchSSGA(sym) {
  const url = `https://www.ssga.com/us/en/intermediary/etfs/library-content/products/fund-data/etfs/us/holdings-daily-us-en-${sym.toLowerCase()}.xlsx`;
  const resp = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`SSGA ${sym} ${resp.status}`);
  const files = fflate.unzipSync(new Uint8Array(await resp.arrayBuffer()));
  const dec = new TextDecoder();

  // sharedStrings holds the text values referenced by t="s" cells.
  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    const $s = cheerio.load(dec.decode(files['xl/sharedStrings.xml']), { xmlMode: true });
    $s('si').each((_, si) => shared.push($s(si).find('t').map((__, t) => $s(t).text()).get().join('')));
  }
  const sheetKey = Object.keys(files).find(f => /^xl\/worksheets\/sheet1\.xml$/.test(f));
  if (!sheetKey) throw new Error(`SSGA ${sym}: no sheet`);

  const $ = cheerio.load(dec.decode(files[sheetKey]), { xmlMode: true });
  const rows = [];
  $('row').each((_, row) => {
    rows.push($(row).find('c').map((__, c) => {
      const v = $(c).find('v').first().text();
      if (!v) return '';
      return $(c).attr('t') === 's' ? (shared[+v] ?? '') : v;
    }).get());
  });

  const hi = rows.findIndex(r => r.some(x => (x || '').trim().toLowerCase() === 'ticker'));
  if (hi < 0) throw new Error(`SSGA ${sym}: no header`);
  const hdr = rows[hi].map(x => (x || '').trim().toLowerCase());
  const ti = hdr.indexOf('ticker');
  const ni = hdr.indexOf('name');

  const out = [];
  const seen = new Set();
  for (const r of rows.slice(hi + 1)) {
    const symbol = cleanSymbol(r[ti]);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ symbol, name: (r[ni] || symbol).trim() });
  }
  if (!out.length) throw new Error(`SSGA ${sym}: no holdings parsed`);
  return out;
}

// ─── Issuer-direct parsers ───────────────────────────────────────────────────
// StockAnalysis caps its free tier at the top 25 by weight — its own page says
// "Top 25" and offers Pro for the rest. For a cap-weighted fund that is most of
// the money, but the thematic funds are near equal-weight, so the cap silently
// amputates the theme: QTUM's page omitted IONQ, RGTI and QBTS, which are the
// three names anyone opens a quantum fund to see. Verified against Defiance's
// own full-holdings page: 71 holdings, all three present.
//
// So where an issuer publishes the full list server-side, read it from them.
// Each parser takes already-fetched markup, which keeps them testable without
// the network — the fixtures in etfHoldings.test.js are trimmed real responses.
//
// Not every issuer can be read this way, and the split is measured, not assumed:
// iShares (ITA, ITB, IYT, IGV) answers its own CSV endpoint with 1.4MB of HTML
// and VanEck (REMX, SMH, GDX) redirects forever — both sit behind Akamai bot
// management. Those stay on StockAnalysis and stay capped.

// Rows are identified by a CUSIP-shaped cell rather than by table position, so
// a layout change drops the fund back to the fallback instead of parsing some
// other table on the page into nonsense.
const looksLikeCusip = (s) => /^[0-9A-Z]{9}$/.test((s || '').trim());

/** Defiance (QTUM): <td>TICKER</td><td>Name</td><td>CUSIP</td><td>weight</td> */
function parseDefiance(html) {
  return parseHoldingsTable(html, { symbolCol: 0, nameCol: 1, cusipCol: 2 });
}

/** First Trust (CIBR): <td>Name</td><td>TICKER</td><td>CUSIP</td><td>sector</td> */
function parseFirstTrust(html) {
  return parseHoldingsTable(html, { symbolCol: 1, nameCol: 0, cusipCol: 2 });
}

function parseHoldingsTable(html, { symbolCol, nameCol, cusipCol }) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('tr').each((_, tr) => {
    const cells = $(tr).find('td').map((__, td) => $(td).text().trim()).get();
    if (cells.length <= cusipCol || !looksLikeCusip(cells[cusipCol])) return;
    const symbol = cleanSymbol(cells[symbolCol]);
    if (!symbol || seen.has(symbol)) return;
    seen.add(symbol);
    out.push({ symbol, name: cells[nameCol] || symbol });
  });
  return out;
}

/**
 * Global X (URA, HYDR): the fund page links a dated full-holdings CSV, e.g.
 * .../holdings/ura_full-holdings_20260812.csv. Header row is
 *   % of Net Assets,Ticker,Name,SEDOL,Market Price ($),Shares Held,Market Value
 *
 * The CSV is the complete list — 63 lines for URA against the 13 StockAnalysis
 * exposes — but its tickers are Bloomberg-style, so foreign lines read "CCO CN"
 * (Cameco, Toronto) and "BKY SM" (Madrid). Those are dropped by cleanSymbol,
 * and deliberately NOT repaired by stripping the country code: "CCO" is Clear
 * Channel Outdoor, a different company entirely. Stripping suffixes generates
 * tickers that price successfully and name the wrong business, which is worse
 * than a short list. The union with StockAnalysis below recovers the dual-listed
 * names properly, through FOREIGN_US_MAP, which was curated for exactly this.
 */
function parseGlobalXCsv(text) {
  const out = [];
  const seen = new Set();
  const lines = text.split(/\r?\n/);
  const hi = lines.findIndex(l => /(^|,)ticker(,|$)/i.test(l));
  if (hi < 0) return out;
  const hdr = splitCsvLine(lines[hi]).map(h => h.trim().toLowerCase());
  const ti = hdr.indexOf('ticker');
  const ni = hdr.indexOf('name');
  if (ti < 0) return out;
  for (const line of lines.slice(hi + 1)) {
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    const symbol = cleanSymbol(cells[ti]);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ symbol, name: (cells[ni] || symbol).trim() });
  }
  return out;
}

// Fields are quoted only when they contain a comma ("20,013,978.00"), so a
// split on commas alone corrupts every row after the first quoted number.
function splitCsvLine(line) {
  const cells = [];
  let cur = '', inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

// Funds whose issuer serves the full list, with the URL and parser for each.
//
// Procure (UFO) is absent on purpose: its fund page publishes only a top-10
// table, and the only full lists are semi-annual Schedule-of-Investments
// spreadsheets, the newest dated April 2025. A four-month-old membership is not
// an improvement on a capped current one, so UFO stays on StockAnalysis.
const ISSUER_SOURCES = {
  QTUM: { url: 'https://www.defianceetfs.com/qtum-full-holdings/', parse: parseDefiance },
  CIBR: { url: 'https://www.ftportfolios.com/Retail/Etf/EtfHoldings.aspx?Ticker=CIBR', parse: parseFirstTrust },
  // Two hops: the CSV filename carries the as-of date, so it has to be read off
  // the fund page rather than constructed.
  URA:  { url: 'https://www.globalxetfs.com/funds/ura/', parse: parseGlobalXCsv, csvFrom: 'ura' },
  HYDR: { url: 'https://www.globalxetfs.com/funds/hydr/', parse: parseGlobalXCsv, csvFrom: 'hydr' },
};

async function fetchIssuer(sym) {
  const src = ISSUER_SOURCES[sym];
  const resp = await fetch(src.url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!resp.ok) throw new Error(`issuer ${sym} ${resp.status}`);
  let body = await resp.text();

  if (src.csvFrom) {
    const m = body.match(new RegExp(`https?://[^"'\\\\\\s]*${src.csvFrom}_full-holdings_\\d+\\.csv`, 'i'));
    if (!m) throw new Error(`issuer ${sym}: no holdings CSV link`);
    const csv = await fetch(m[0], { headers: { 'User-Agent': UA } });
    if (!csv.ok) throw new Error(`issuer ${sym} csv ${csv.status}`);
    body = await csv.text();
  }

  const out = src.parse(body);
  if (!out.length) throw new Error(`issuer ${sym}: no holdings parsed`);
  return out;
}

// ─── Everyone else: StockAnalysis.com (top ~25 by weight) ────────────────────
// The old JSON API (/api/symbol/e/<sym>/holdings) started returning 404, so
// primary is now the holdings page itself: the SvelteKit payload embeds rows
// as JS object literals like {no:7,n:"ASML Holding N.V.",s:"$ASML",...}. The
// API is still tried first in case it comes back.
async function fetchStockAnalysis(sym) {
  const out = [];
  const seen = new Set();
  const push = (rawSym, rawName) => {
    const symbol = cleanSymbol(rawSym);
    if (!symbol || seen.has(symbol)) return;
    seen.add(symbol);
    out.push({ symbol, name: (rawName || symbol).trim() });
  };

  const resp = await fetch(`https://stockanalysis.com/api/symbol/e/${sym}/holdings`, { headers: { 'User-Agent': UA } });
  if (resp.ok) {
    const j = await resp.json().catch(() => null);
    for (const h of j?.data?.holdings || []) push(h.s, h.n);
  }

  if (!out.length) {
    const page = await fetch(`https://stockanalysis.com/etf/${sym.toLowerCase()}/holdings/`, { headers: { 'User-Agent': UA } });
    if (!page.ok) throw new Error(`StockAnalysis ${sym} page ${page.status}`);
    const html = await page.text();
    for (const m of html.matchAll(/\{no:\d+,n:"([^"]*)",s:"([^"]*)"/g)) push(m[2], m[1]);
  }

  if (!out.length) throw new Error(`StockAnalysis ${sym}: no holdings`);
  return out;
}

/**
 * Union of the issuer's list and StockAnalysis's, issuer first.
 *
 * Union rather than "issuer instead of", because neither source dominates and
 * the first attempt at this made three drilldowns WORSE — measured, which is
 * the only reason it was caught:
 *
 *      fund    StockAnalysis   issuer alone
 *      QTUM              21              68
 *      CIBR              21              38
 *      URA               13              12
 *      HYDR              14               7
 *
 * The issuer files are complete but list foreign lines in Bloomberg form, which
 * this module drops as unpriceable; StockAnalysis is capped at 25 but has
 * already resolved the dual-listed names to their US tickers. Taking both keeps
 * every name either one can name correctly, and cannot return fewer than the
 * capped list it replaced.
 *
 * If the issuer fetch fails outright, the StockAnalysis list still stands on its
 * own, so a fund site changing shape degrades to the old behaviour rather than
 * emptying a page.
 */
async function fetchIssuerUnion(sym) {
  const [issuer, fallback] = await Promise.all([
    fetchIssuer(sym).catch(e => {
      console.warn(`[etfHoldings] ${sym} issuer fetch failed (${e.message}); using StockAnalysis alone`);
      return [];
    }),
    fetchStockAnalysis(sym).catch(() => []),
  ]);
  const out = [...issuer];
  const seen = new Set(issuer.map(h => h.symbol));
  for (const h of fallback) {
    if (seen.has(h.symbol)) continue;
    seen.add(h.symbol);
    out.push(h);
  }
  if (!out.length) throw new Error(`${sym}: no holdings from either source`);
  return out;
}

// Returns [{ symbol, name }] for the ETF, or null if it can't be resolved.
async function getEtfHoldings(symbol) {
  const sym = symbol.toUpperCase();
  const hit = cache[sym];
  if (hit && Date.now() - hit.ts < TTL) return hit.data;
  if (inflight[sym]) return inflight[sym];

  inflight[sym] = (async () => {
    try {
      let data;
      if (SSGA_FUNDS.has(sym)) {
        data = await fetchSSGA(sym);
      } else if (ISSUER_SOURCES[sym]) {
        data = await fetchIssuerUnion(sym);
      } else {
        data = await fetchStockAnalysis(sym);
      }
      cache[sym] = { data, ts: Date.now() };
      return data;
    } catch (e) {
      console.warn(`[etfHoldings] ${sym} failed: ${e.message}`);
      return hit ? hit.data : null; // stale beats nothing
    } finally {
      delete inflight[sym];
    }
  })();
  return inflight[sym];
}

module.exports = {
  getEtfHoldings,
  // Exported for tests: the parsers are pure, so they are checked against
  // trimmed real responses rather than by hitting five fund websites.
  parseDefiance, parseFirstTrust, parseGlobalXCsv, splitCsvLine, cleanSymbol, ISSUER_SOURCES,
};
