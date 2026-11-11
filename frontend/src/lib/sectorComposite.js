// Warm constituent histories progressively before asking the existing backend
// to calculate its equal-weighted composite. A cold 50-stock build otherwise
// outlives one HTTP request and leaves the row at its empty placeholder.
export async function loadSectorComposite(sectorKey, { fetcher, signal, onProgress = () => {} }) {
  const checkAbort = () => signal?.throwIfAborted();
  const readJson = async (url, options = {}) => {
    checkAbort();
    const response = await fetcher(url, { signal, timeoutMs: 20_000, ...options });
    const payload = await response.json();
    checkAbort();
    if (!response.ok || payload.error || payload.isError) {
      throw new Error(payload.error || 'Sector data is temporarily unavailable.');
    }
    return payload;
  };

  const members = await readJson(`/api/sector-constituents/${encodeURIComponent(sectorKey)}`);
  const tokens = [...new Set((members.constituents || []).filter(row => row.token).map(row => String(row.token)))];
  if (!tokens.length) throw new Error('No priceable constituent stocks are available.');

  let warm = new Set();
  try {
    const probe = await readJson('/api/historical-full/cached', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens }),
    });
    warm = new Set((probe.cachedTokens || []).map(String).filter(token => tokens.includes(token)));
  } catch {
    checkAbort(); // The optional cache probe must not block a real history load.
  }

  let completed = warm.size;
  const total = tokens.length;
  const progress = () => onProgress({ completed, total, phase: 'history' });
  progress();
  const cold = tokens.filter(token => !warm.has(token));
  const failed = [];
  let cursor = 0;

  const workers = Array.from({ length: Math.min(3, cold.length) }, async () => {
    while (cursor < cold.length) {
      checkAbort();
      const token = cold[cursor++];
      try {
        const payload = await readJson(`/api/historical-full/${encodeURIComponent(token)}`, { timeoutMs: 120_000 });
        checkAbort();
        const candles = JSON.parse(payload.content?.[0]?.text || 'null');
        if (!Array.isArray(candles) || !candles.length) throw new Error('Price history unavailable');
        completed++;
        progress();
      } catch {
        checkAbort();
        failed.push(token);
      }
    }
  });
  await Promise.all(workers);
  checkAbort();
  if (failed.length) throw new Error(`${failed.length} of ${total} stock histories could not load. Retry to finish.`);

  onProgress({ completed, total, phase: 'composite' });
  // All histories now live in the server cache, making this a short calculation
  // rather than another long upstream fetch. Keep the existing calculation and
  // return windows authoritative on the backend.
  const result = await readJson(`/api/sector-composite/${encodeURIComponent(sectorKey)}`);
  if (!Array.isArray(result.series) || !result.series.length || !(result.lastClose > 0)) {
    throw new Error('Composite price history is unavailable. Please retry.');
  }
  return result;
}
