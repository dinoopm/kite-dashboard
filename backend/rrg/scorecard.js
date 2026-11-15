// ─── RRG rotation scorecard (US) ─────────────────────────────────────────────
//
// GET /api/rrg/scorecard — the track record behind the four quadrant-entry
// signals, in two halves that are never pooled:
//
//   reconstructed  the RRG rebuilt from ~11 years of Alpaca daily bars and
//                  every entry scored. Available at once, and weaker: found
//                  after the fact, on dividend-adjusted prices that are
//                  restated as new dividends are paid.
//   recorded       rows the weekly job wrote to signal_emissions the weekend
//                  an entry happened (signals/record.recordRrgEntries). Starts
//                  empty and grows by a handful a week.
//
// First run on 2026-11-16 (29 sector ETFs against SPY, weeks 2017-06-23 →
// 2026-11-13, ~190 entries per quadrant over ~150 distinct weeks): no entry
// showed an edge at 8 weeks that coin flips would not produce. Entering
// Leading: +0.07% median, 50.5% beat SPY. Entering Improving — the textbook
// "next stop Leading" — −0.44%, 47.4%. Entering Lagging came closest
// (−0.88%, 42.6%; −1.48% and 41.7% at 13 weeks), i.e. laggards tended to keep
// lagging. That is what the badges say, and it is the reason to have them:
// the chart is a description of where sectors have been, not a forecast.
//
// India is not scored here: its sector indices come through a live Kite
// session, which a scheduled job does not have. It is registered as blocked.

const { createClient } = require('../auth/database');
const { fetchBarsMulti } = require('../alpacaData');
const { scoreRotation, RULE_VERSION } = require('./rotation');
const { US_RRG_KEYS, US_RRG_BENCHMARK } = require('./universe');
const { signalMeta } = require('../signals/registry');

// As far back as Alpaca's free history goes; the first scoreable week is ~18
// months later, once the 52- and 26-week averages exist.
const STUDY_START = new Date('2015-06-01T00:00:00Z');
const TTL_MS = 12 * 60 * 60 * 1000;

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY) : null;

/** Rows the weekly job recorded under the CURRENT rule version. */
async function fetchRecorded(db = supabase) {
  if (!db) return [];
  const { data, error } = await db.from('signal_emissions')
    .select('signal,snap_date,symbol')
    .eq('source', 'recorded')
    .like('signal', `us_rrg_enter_%@${RULE_VERSION}`)
    .order('snap_date', { ascending: true });
  if (error) throw new Error(`signal_emissions: ${error.message}`);
  return (data || []).map(r => ({ signal: r.signal.split('@')[0], symbol: r.symbol, date: r.snap_date }));
}

async function buildUsRotationScorecard({ fetchBars = fetchBarsMulti, recordedRows = fetchRecorded, now = new Date() } = {}) {
  const bars = await fetchBars([US_RRG_BENCHMARK, ...US_RRG_KEYS], STUDY_START);
  const bench = bars[US_RRG_BENCHMARK];
  if (!bench?.length) throw new Error(`No ${US_RRG_BENCHMARK} history`);
  const sectors = Object.fromEntries(US_RRG_KEYS.filter(k => bars[k]?.length).map(k => [k, bars[k]]));
  // A scorecard that cannot read its recorded half still has its reconstructed
  // one; say so rather than fail the whole badge row.
  let recorded = [], recordedError = null;
  try { recorded = await recordedRows(); } catch (e) { recordedError = e.message; }

  const out = scoreRotation(sectors, bench, { market: 'US', benchmark: US_RRG_BENCHMARK, now, recorded });
  for (const s of out.signals) {
    const meta = signalMeta(s.signal);
    s.label = meta?.label || s.signal;
    s.description = meta?.description || null;
  }
  return {
    ...out, generatedAt: now.toISOString(), recordedError,
    notes: [
      `Excess is over ${US_RRG_BENCHMARK}, from the close of the week a sector entered the quadrant.`,
      'Reconstructed and recorded entries are scored separately and never pooled.',
      'Sectors rotate together, so entries cluster in the same weeks: the "distinct weeks" count, not n, is the measure of independent evidence, and the noise test uses it.',
      'Prices are dividend-adjusted and restated over time; the reconstruction can drift slightly between runs.',
    ],
  };
}

let cache = { data: null, ts: 0 };
let inflight = null;
/** Cached for 12h: one build reads ~80k daily bars, and the answer changes weekly. */
function getUsRotationScorecard() {
  if (cache.data && Date.now() - cache.ts < TTL_MS) return Promise.resolve({ ...cache.data, cached: true });
  if (!inflight) {
    inflight = buildUsRotationScorecard()
      .then(data => { cache = { data, ts: Date.now() }; return data; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

module.exports = { buildUsRotationScorecard, getUsRotationScorecard, fetchRecorded, STUDY_START };
