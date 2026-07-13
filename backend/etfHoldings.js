// Live ETF holdings for the US drilldown ("Stocks" tab). Replaces the curated
// 10-name stubs in alpaca.js with each fund's actual membership.
//
// Sources, by issuer:
//   • SPDR / State Street (XBI, KRE, XOP, XRT, DIA, …) — full daily-holdings
//     xlsx. Returns the complete membership (e.g. XBI ≈ 150 names).
//   • Everyone else (VanEck SMH/GDX, iShares ITB/IYT/IGV, …) — StockAnalysis.com
//     holdings API. iShares/VanEck sit behind Akamai bot-management, so their
//     own CSV/ajax endpoints can't be fetched server-side (even via a headless
//     browser the full list comes from a blocked ajax call); StockAnalysis is
//     the reliable uniform source, but its free tier caps at the top ~25 by
//     weight.
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

// Normalize to a ticker Alpaca can price: letters with an optional dot class
// (BRK.B). StockAnalysis tags non-US-primary listings as "!TSX/AEM" — take the
// segment after the slash, which is the US ticker for the many dual-listed
// names (AEM, WPM, FNV… in GDX). Cash/derivative rows fail the test → dropped.
const cleanSymbol = (raw) => {
  let s = (raw || '').replace(/^\$/, '').trim().toUpperCase();
  if (s.includes('/')) s = s.split('/').pop(); // "!TSX/AEM" -> "AEM"
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

// Returns [{ symbol, name }] for the ETF, or null if it can't be resolved.
async function getEtfHoldings(symbol) {
  const sym = symbol.toUpperCase();
  const hit = cache[sym];
  if (hit && Date.now() - hit.ts < TTL) return hit.data;
  if (inflight[sym]) return inflight[sym];

  inflight[sym] = (async () => {
    try {
      const data = SSGA_FUNDS.has(sym) ? await fetchSSGA(sym) : await fetchStockAnalysis(sym);
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

module.exports = { getEtfHoldings };
