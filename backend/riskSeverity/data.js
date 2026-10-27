const { fetchSeries, hasApiKey } = require('../macro/fred');
// Public-source checks deliberately do NOT invent first-publication times.
// An ALFRED vintage date has day precision; for any future provider adapter it
// must be delayed until the following calendar day (or replaced by a documented
// timestamp), never assumed available at that same day's market close.
async function probeHistoricalCredit({ start = '2005-01-01', end = new Date().toISOString().slice(0, 10), request = fetch } = {}) {
  const diagnostic = { source: 'FRED / ALFRED BAMLH0A0HYM2', vintageAvailable: false, first: null, last: null };
  if (!hasApiKey()) return { ...diagnostic, error: 'FRED_API_KEY is not configured. The keyless current-history CSV cannot supply historical vintages.' };
  try {
    const params = new URLSearchParams({ series_id: 'BAMLH0A0HYM2', api_key: process.env.FRED_API_KEY, file_type: 'json',
      observation_start: start, observation_end: end, realtime_start: '2007-01-01', realtime_end: '2007-01-01', limit: '100000' });
    const response = await request(`https://api.stlouisfed.org/fred/series/observations?${params}`, { signal: AbortSignal.timeout(20000) });
    const result = await response.json();
    if (!response.ok || result.error_message) throw Error(String(result.error_message || `FRED HTTP ${response.status}`).split(process.env.FRED_API_KEY).join('[redacted]'));
    diagnostic.vintageAvailable = Boolean(result.observations?.length);
    diagnostic.error = diagnostic.vintageAvailable ? 'Historical credit query returned observations, but a complete, timestamped price/credit vintage archive and exchange calendar must still be supplied with --input.' : 'No historical vintage observations were returned.';
  } catch (error) { diagnostic.error = `Historical credit vintages unavailable: ${error.name === 'TimeoutError' ? 'source timeout' : error.message}`; }
  try {
    const current = await fetchSeries('BAMLH0A0HYM2', { start });
    const valid = current.observations.filter(row => Number.isFinite(row.value));
    diagnostic.first = valid[0]?.observation_date || null; diagnostic.last = valid.at(-1)?.observation_date || null;
  } catch { /* diagnostic only; current history is never substituted for vintages */ }
  return diagnostic;
}
module.exports = { probeHistoricalCredit };
