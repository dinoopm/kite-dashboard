// ─── Yahoo per-ticker news (RSS) ─────────────────────────────────────────────
// Yahoo's headline RSS feed is symbol-scoped and far more relevant than the
// fuzzy `search` news (which returns unrelated stories for .NS tickers). Used
// by the instrument-page News tabs: US passes the plain ticker, India passes
// SYMBOL.NS. Some thinly-covered Indian names return an empty feed — callers
// surface that as "no recent news", not an error.

const axios = require('axios');
const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const decode = (s) => (s || '')
  .replace(/<!\[CDATA\[|\]\]>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .trim();

// "stocktwits.com/…" -> "Stocktwits"; falls back to the bare hostname.
const sourceFromLink = (link) => {
  try {
    const host = new URL(link).hostname.replace(/^www\./, '');
    const name = host.split('.')[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch { return null; }
};

async function fromRss(yahooSymbol, limit) {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(yahooSymbol)}&region=US&lang=en-US`;
  const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' }, timeout: 12000, responseType: 'text' });
  const items = [];
  for (const m of String(r.data).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (tag) => { const mm = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)); return mm ? decode(mm[1]) : null; };
    const link = pick('link'), title = pick('title');
    if (!title || !link) continue;
    const pub = pick('pubDate');
    items.push({ title, link, summary: pick('description'), source: sourceFromLink(link), publishedAt: pub ? new Date(pub).toISOString() : null });
    if (items.length >= limit) break;
  }
  return items;
}

// Fallback via the yahoo-finance2 search client (a different host, less prone
// to the RSS feed's rate-limiting). Filtered to headlines whose relatedTickers
// include this symbol — search is fuzzy and returns unrelated stories for
// non-US tickers, so the filter keeps it honest (relevant items, or none).
async function fromSearch(yahooSymbol, limit) {
  const q = yf.search ? await yf.search(yahooSymbol, { newsCount: limit, quotesCount: 0 }, { validateResult: false }) : null;
  const bare = yahooSymbol.replace(/\.[A-Z]+$/i, '').toUpperCase();
  return (q?.news || [])
    .filter(n => (n.relatedTickers || []).some(t => { const u = t.toUpperCase(); return u === yahooSymbol.toUpperCase() || u === bare; }))
    .slice(0, limit)
    .map(n => ({
      title: n.title,
      link: n.link,
      summary: null,
      source: n.publisher || sourceFromLink(n.link),
      publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime).toISOString() : null,
    }));
}

// Search first: it runs on Yahoo's crumb-authed API host (robust, doesn't
// rate-limit like the RSS feed) and its relatedTickers tagging is reliable for
// US names — so the common US path never touches the fragile feeds host.
// Yahoo doesn't tag Indian .NS tickers, so search returns ~nothing for them;
// that thin result falls back to the ticker-scoped RSS feed, which is the only
// good India source (it 429s only under heavy burst load, which the 15-min
// per-symbol cache keeps us well clear of).
async function fetchYahooNews(yahooSymbol, limit = 20) {
  let searchItems = [];
  try { searchItems = await fromSearch(yahooSymbol, limit); } catch { /* try RSS */ }
  if (searchItems.length >= 3) return searchItems;
  try {
    const rss = await fromRss(yahooSymbol, limit);
    if (rss.length) return rss;
  } catch { /* keep whatever search gave */ }
  return searchItems;
}

module.exports = { fetchYahooNews };
