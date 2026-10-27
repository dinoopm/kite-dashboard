const LOOKBACKS = { '1W': 5, '1M': 22, '3M': 66, '6M': 132, '1Y': 252, '2Y': 504, '3Y': 756 };
export function historyPricingInputs(series) {
  return {
    anchors: Object.fromEntries(Object.entries(LOOKBACKS).map(([key, count]) => [key, series.length >= count ? series[series.length - count].close : null])),
    high52: Math.max(0, ...series.slice(-252).map(b => b.close)),
    sma50: series.length >= 50 ? series.slice(-50).reduce((s, b) => s + b.close, 0) / 50 : null,
  };
}
export function returnsAtPrice(inputs, currentPrice) {
  if (!inputs || !(currentPrice > 0)) return {};
  const high = Math.max(inputs.high52, currentPrice);
  return {
    ...Object.fromEntries(Object.entries(inputs.anchors).map(([key, anchor]) => [key, anchor > 0 ? (currentPrice / anchor - 1) * 100 : null])),
    dist52WHigh: high > 0 ? (currentPrice / high - 1) * 100 : null,
    aboveSma50: inputs.sma50 != null ? currentPrice > inputs.sma50 : null,
  };
}
export function mergeIndexQuote(row, quote) {
  const currentPrice = quote.last_price;
  // A temporary missing quote must not wipe out a previously valid price.
  if (!(currentPrice > 0)) return row;
  const previousClose = quote.ohlc?.close;
  return {
    ...row, token: quote.instrument_token ?? row.token, price: currentPrice,
    '1D': previousClose > 0 ? (currentPrice / previousClose - 1) * 100 : null,
    quoteSession: quote.quote_session ?? null, quoteAsOf: quote.quote_as_of ?? null,
    quoteFeed: quote.feed ?? null,
    ...returnsAtPrice(row.pricingInputs, currentPrice),
  };
}
export function quoteLabel(row) {
  if (row.token === 'synthetic') return 'Daily composite';
  const labels = { regular: 'Regular', 'regular-close': 'Regular close', 'pre-market': 'Pre-market', 'after-hours': 'After-hours' };
  const label = labels[row.quoteSession] || 'Cached quote';
  if (!row.quoteAsOf || !Number.isFinite(Date.parse(row.quoteAsOf))) return label;
  const closeOnly = row.quoteSession === 'regular-close';
  return `${label} · ${new Date(row.quoteAsOf).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric',
    ...(!closeOnly ? { hour: 'numeric', minute: '2-digit' } : {}),
  })}${closeOnly ? '' : ' ET'}`;
}
export function quoteFeedLabel(feed) {
  return feed === 'delayed_sip' ? '15-min delayed' : feed === 'iex' ? 'IEX feed' : feed === 'sip' ? 'SIP feed' : 'Feed not confirmed';
}
