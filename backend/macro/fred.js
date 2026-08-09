// ─── FRED client ─────────────────────────────────────────────────────────────
//
// Two transports against the same official St. Louis Fed host:
//
//   · The JSON observations API (fred/series/observations) when FRED_API_KEY is
//     set. Richer — it accepts realtime_start/realtime_end, which is how you
//     ask ALFRED for a VINTAGE: the value as it was known on a past date. That
//     is what makes an honest reconstruction possible, because a backtest that
//     reads today's payrolls is reading a number revised twice since.
//   · The keyless CSV endpoint (fredgraph.csv) otherwise, so the feature works
//     before anyone registers for a key. Same data, no vintages.
//
// The two disagree about how they spell "no observation": the JSON API sends
// ".", the CSV sends an empty field. parseFredValue absorbs both, and the
// distinction never reaches the database.
//
// Get a key (free, instant) at https://fredaccount.stlouisfed.org/apikeys and
// put FRED_API_KEY in .env to unlock vintages.

const { parseFredValue } = require('./calc');

const CSV_BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const API_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const UA = { 'User-Agent': 'kite-dashboard/1.0 (macro decision monitor)' };

const hasApiKey = () => Boolean(process.env.FRED_API_KEY);

/** Fetch with a timeout and a couple of retries on transient failures. */
async function fetchWithRetry(url, { attempts = 3, timeoutMs = 20000 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: UA, signal: ctl.signal });
      // 4xx other than 429 is a bad request — retrying sends the same bad
      // request again, so fail fast and surface it.
      if (!r.ok && r.status < 500 && r.status !== 429) {
        throw new Error(`FRED HTTP ${r.status}`);
      }
      if (!r.ok) throw new Error(`FRED HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      lastErr = e;
      if (e.message?.includes('HTTP 4') && !e.message.includes('429')) throw e;
      if (i < attempts - 1) await new Promise(res => setTimeout(res, 500 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('FRED fetch failed');
}

/** `observation_date,SERIESID` with an empty field for no observation. */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const [date, raw] = lines[i].split(',');
    if (!/^\d{4}-\d{2}-\d{2}$/.test((date || '').trim())) continue;
    out.push({ observation_date: date.trim(), value: parseFredValue(raw) });
  }
  return out;
}

/**
 * Observations for one series, oldest first.
 *
 * `asOf` requests the vintage known on that date and is silently ignored
 * without an API key — the caller is told via `vintageHonoured` rather than
 * being handed present-day data labelled as history.
 */
async function fetchSeries(seriesId, { start = null, asOf = null } = {}) {
  const cosd = start || '2000-01-01';

  if (hasApiKey()) {
    const p = new URLSearchParams({
      series_id: seriesId,
      api_key: process.env.FRED_API_KEY,
      file_type: 'json',
      observation_start: cosd,
    });
    if (asOf) { p.set('realtime_start', asOf); p.set('realtime_end', asOf); }
    const body = await fetchWithRetry(`${API_BASE}?${p}`);
    const json = JSON.parse(body);
    if (json.error_message) throw new Error(`FRED: ${json.error_message}`);
    return {
      seriesId,
      vintageHonoured: Boolean(asOf),
      observations: (json.observations || []).map(o => ({
        observation_date: o.date,
        value: parseFredValue(o.value),
        realtime_start: o.realtime_start || null,
      })),
    };
  }

  const p = new URLSearchParams({ id: seriesId, cosd });
  const text = await fetchWithRetry(`${CSV_BASE}?${p}`);
  return { seriesId, vintageHonoured: false, observations: parseCsv(text) };
}

/**
 * Several series, sequentially with a small pause.
 *
 * Sequential on purpose: this runs a handful of times a day against a public
 * good, and the whole job finishes in seconds either way. One series failing
 * does not sink the rest — the monitor degrades to the signals it can compute
 * and reports reduced coverage.
 */
async function fetchMany(seriesIds, opts = {}) {
  const out = {};
  const errors = {};
  for (const id of seriesIds) {
    try {
      out[id] = await fetchSeries(id, opts);
    } catch (e) {
      errors[id] = e.message;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return { series: out, errors };
}

module.exports = { fetchSeries, fetchMany, parseCsv, hasApiKey };
