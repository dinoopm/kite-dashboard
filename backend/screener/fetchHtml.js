// ─── screener.in page fetch, shared ──────────────────────────────────────────
//
// Extracted from server.js so the nightly fundamentals ingest can reach
// screener.in without booting an HTTP server and calling its own API. The cache
// and the in-flight map are module state on purpose: several endpoints and the
// ingest all want the same page, and one fetch should serve them all.
//
// Cached aggressively because quarterly data changes four times a year — which
// also, deliberately, keeps us off screener's radar. The ingest walks ~239
// symbols a night and must stay polite: low concurrency, and a delay between
// pages.

const SCREENER_TTL = 12 * 60 * 60 * 1000; // 12h
const screenerHtmlCache = {}; // symbol -> { html, ts } — raw HTML shared across endpoints
const screenerHtmlInflight = {}; // symbol -> Promise so concurrent requests dedupe

// ─── Screener-slug aliases for Kite ↔ screener.in mismatches ─────
// A handful of NSE tickers carry an "&" in their symbol on the exchange but
// Kite normalises them by stripping the suffix (e.g. NSE: GVT&D → Kite: GVT).
// Screener.in keeps the full ampersand form, so a direct slug lookup 404s
// for these names. Hardcoded map keeps the path explicit — add an entry as
// new mismatches surface.
const SCREENER_SLUG_ALIASES = {
  'GVT': 'GVT&D',     // GE Vernova T&D India
  'JK': 'J&KBANK',    // J&K Bank — actual Kite tradingsymbol is J&KBANK,
                       // but covering the bare prefix in case Kite ever
                       // normalises it the same way they did GVT.
};

// Shared HTML fetch. Multiple endpoints scrape the same page; this caches the
// raw HTML so /api/screener-quarterly and /api/screener-cashflow don't each
// hit screener.in independently.
//
// Lookup strategy:
//   1. Apply any hardcoded alias (covers Kite → screener slug rewrites).
//   2. Try the resolved slug.
//   3. On 404, fall back to the original symbol (in case the alias was wrong).
//   4. If both 404, propagate the error.
async function fetchScreenerHTML(symbol, { consolidated = false } = {}) {
  // Consolidated and standalone are different pages on screener.in. Cache them
  // independently so a request for one doesn't poison the other.
  const cacheKey = consolidated ? `${symbol}::consolidated` : symbol;
  const cached = screenerHtmlCache[cacheKey];
  if (cached && Date.now() - cached.ts < SCREENER_TTL) return { html: cached.html, hit: true };
  if (screenerHtmlInflight[cacheKey]) return screenerHtmlInflight[cacheKey];

  const slugCandidates = [];
  if (SCREENER_SLUG_ALIASES[symbol]) slugCandidates.push(SCREENER_SLUG_ALIASES[symbol]);
  // NSE series suffixes (BE = Trade-to-Trade, BZ, SM = SME, etc.) ride on the
  // Kite tradingsymbol — e.g. SIGMAADV-BE — but screener.in keys off the base
  // symbol (SIGMAADV). Strip a known 2-letter series suffix and try the base
  // first. (Only matches the known set, so hyphenated names like BAJAJ-AUTO are
  // left untouched.)
  const baseSymbol = symbol.replace(/-(BE|BZ|BL|IL|SM|ST|GB|GC|GS|DR)$/i, '');
  if (baseSymbol !== symbol) slugCandidates.push(baseSymbol);
  slugCandidates.push(symbol);

  const tryFetch = async (slug) => {
    const suffix = consolidated ? 'consolidated/' : '';
    const url = `https://www.screener.in/company/${encodeURIComponent(slug)}/${suffix}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    return r;
  };

  const p = (async () => {
    try {
      let lastErr = null;
      for (const slug of slugCandidates) {
        const r = await tryFetch(slug);
        if (r.ok) {
          const html = await r.text();
          screenerHtmlCache[cacheKey] = { html, ts: Date.now() };
          if (slug !== symbol) {
            console.log(`[screener] ${symbol} resolved via alias slug "${slug}" (${consolidated ? 'consolidated' : 'standalone'})`);
          }
          return { html, hit: false };
        }
        lastErr = new Error(`Screener returned ${r.status} for slug "${slug}"`);
        lastErr.status = r.status;
      }
      throw lastErr || new Error(`Screener returned 404 for all candidates of ${symbol}`);
    } finally {
      delete screenerHtmlInflight[cacheKey];
    }
  })();
  screenerHtmlInflight[cacheKey] = p;
  return p;
}

module.exports = { fetchScreenerHTML, SCREENER_TTL, SCREENER_SLUG_ALIASES };
