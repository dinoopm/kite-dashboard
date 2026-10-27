// One instance per authenticated session worker. Both HTTP routes and internal
// consumers use this getter; no loopback request or extra credentials needed.
function createPortfolioXrayService({ loadHoldings, analyze, isConnected, now = Date.now, ttlMs = 10 * 60 * 1000 }) {
  let cache = null;
  let running = null;

  return async function getPortfolioXray() {
    if (!isConnected()) throw new Error('MCP not connected');
    if (cache && now() - cache.ts < ttlMs) return { ...cache.data, cached: true };
    if (!running) {
      running = Promise.resolve().then(async () => {
        const holdings = await loadHoldings();
        if (!Array.isArray(holdings)) throw new Error('Invalid Kite holdings response');
        const data = holdings.length
          ? await analyze(holdings)
          : { holdings: [], summary: { total: 0, flagged: 0, clean: 0, worstThree: [] } };
        cache = { data, ts: now() };
        return data;
      }).finally(() => { running = null; });
    }
    return running;
  };
}

module.exports = { createPortfolioXrayService };
