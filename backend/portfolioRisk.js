'use strict';

const UNKNOWN_SECTOR = 'Unknown';

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeAndGroupHoldings(rows) {
  if (!Array.isArray(rows)) throw new TypeError('Holdings response must be an array');

  const grouped = new Map();

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const settled = finiteNumber(row.quantity) ?? 0;
    const t1 = finiteNumber(row.t1_quantity) ?? 0;
    const quantity = settled + t1;
    if (!(quantity > 0)) continue;

    const symbol = String(row.tradingsymbol || row.symbol || '').trim().toUpperCase();
    if (!symbol) continue;
    const exchange = String(row.exchange || 'NSE').trim().toUpperCase();
    const isin = row.isin ? String(row.isin).trim().toUpperCase() : null;
    const key = isin ? `ISIN:${isin}` : `${exchange}:${symbol}`;
    const price = finiteNumber(row.last_price);
    const validPrice = price !== null && price > 0;

    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        symbol,
        exchange,
        isin,
        instrumentToken: row.instrument_token != null ? String(row.instrument_token) : null,
        quantity: 0,
        currentValue: 0,
        priced: true,
        sourceRows: 0,
      });
    }

    const item = grouped.get(key);
    item.quantity += quantity;
    item.sourceRows += 1;
    if (validPrice) item.currentValue += quantity * price;
    else item.priced = false;
    if (!item.instrumentToken && row.instrument_token != null) {
      item.instrumentToken = String(row.instrument_token);
    }
  }

  return [...grouped.values()].map(item => ({
    ...item,
    currentValue: item.priced ? item.currentValue : null,
  }));
}

function aggregatePortfolio(groupedHoldings) {
  const unpricedHoldings = groupedHoldings
    .filter(item => !item.priced || !Number.isFinite(item.currentValue) || item.currentValue <= 0)
    .map(({ key, symbol, exchange, isin, instrumentToken, quantity }) => ({
      key, symbol, exchange, isin, instrumentToken, quantity,
    }));

  const valued = groupedHoldings.filter(
    item => item.priced && Number.isFinite(item.currentValue) && item.currentValue > 0
  );
  const coveredValue = valued.reduce((sum, item) => sum + item.currentValue, 0);

  const positions = valued
    .map(item => ({
      ...item,
      sector: item.sector || UNKNOWN_SECTOR,
      weightPct: coveredValue > 0 ? (item.currentValue / coveredValue) * 100 : 0,
    }))
    .sort((a, b) => b.currentValue - a.currentValue || a.symbol.localeCompare(b.symbol));

  const sectorMap = new Map();
  for (const position of positions) {
    const sector = position.sector || UNKNOWN_SECTOR;
    if (!sectorMap.has(sector)) {
      sectorMap.set(sector, { sector, currentValue: 0, holdingCount: 0, symbols: [] });
    }
    const entry = sectorMap.get(sector);
    entry.currentValue += position.currentValue;
    entry.holdingCount += 1;
    entry.symbols.push(position.symbol);
  }

  const sectors = [...sectorMap.values()]
    .map(entry => ({
      ...entry,
      weightPct: coveredValue > 0 ? (entry.currentValue / coveredValue) * 100 : 0,
    }))
    .sort((a, b) => b.currentValue - a.currentValue || a.sector.localeCompare(b.sector));

  const classifiedValue = sectors
    .filter(entry => entry.sector !== UNKNOWN_SECTOR)
    .reduce((sum, entry) => sum + entry.currentValue, 0);
  const largestClassifiedSector = sectors.find(entry => entry.sector !== UNKNOWN_SECTOR) || null;

  return {
    positions,
    sectors,
    summary: {
      coveredValue,
      holdingCount: positions.length,
      largestPosition: positions[0] || null,
      topFiveWeightPct: positions.slice(0, 5).reduce((sum, item) => sum + item.weightPct, 0),
      largestClassifiedSector,
    },
    coverage: {
      totalHoldingCount: groupedHoldings.length,
      valuedHoldingCount: positions.length,
      unpricedHoldingCount: unpricedHoldings.length,
      unpricedHoldings,
      classifiedValue,
      classificationCoveragePct: coveredValue > 0 ? (classifiedValue / coveredValue) * 100 : 0,
      complete: unpricedHoldings.length === 0,
    },
  };
}

function withDeadline(promise, milliseconds) {
  if (milliseconds <= 0) return Promise.resolve(UNKNOWN_SECTOR);
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise(resolve => {
      timer = setTimeout(() => resolve(UNKNOWN_SECTOR), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function enrichSectors(holdings, resolveSector, timeoutMs, concurrency) {
  if (holdings.length === 0) return holdings;
  const result = holdings.map(item => ({ ...item, sector: UNKNOWN_SECTOR }));
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;

  async function worker() {
    while (cursor < holdings.length) {
      const index = cursor++;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      try {
        const sector = await withDeadline(resolveSector(holdings[index]), remaining);
        result[index].sector = typeof sector === 'string' && sector.trim()
          ? sector.trim()
          : UNKNOWN_SECTOR;
      } catch {
        result[index].sector = UNKNOWN_SECTOR;
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), holdings.length) },
    () => worker()
  ));
  return result;
}

function createPortfolioRiskService({
  fetchHoldings,
  resolveSector,
  timeoutMs = 8000,
  concurrency = 3,
  now = () => new Date(),
}) {
  if (typeof fetchHoldings !== 'function') throw new TypeError('fetchHoldings is required');
  if (typeof resolveSector !== 'function') throw new TypeError('resolveSector is required');

  return async function getPortfolioRisk() {
    const fetched = await fetchHoldings();
    const rows = Array.isArray(fetched) ? fetched : fetched?.rows;
    if (!Array.isArray(rows)) {
      const error = new Error('Malformed holdings response from broker');
      error.statusCode = 502;
      throw error;
    }

    const grouped = normalizeAndGroupHoldings(rows);
    const priced = grouped.filter(
      item => item.priced && Number.isFinite(item.currentValue) && item.currentValue > 0
    );
    const unpriced = grouped.filter(item => !priced.includes(item));
    const enriched = [
      ...await enrichSectors(priced, resolveSector, timeoutMs, concurrency),
      ...unpriced,
    ];
    const result = aggregatePortfolio(enriched);
    const fallbackTime = now();
    const fetchedAt = fetched?.fetchedAt ?? fallbackTime;

    return {
      ...result,
      holdingsFetchedAt: new Date(fetchedAt).toISOString(),
    };
  };
}

module.exports = {
  UNKNOWN_SECTOR,
  aggregatePortfolio,
  createPortfolioRiskService,
  enrichSectors,
  finiteNumber,
  normalizeAndGroupHoldings,
};
