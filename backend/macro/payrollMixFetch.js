// ─── GET /api/macro/payroll-mix — fetching half of payrollMix.js ────────────
//
// All twelve series come from FRED in ONE call, including PAYEMS itself, even
// though the catalogue already stores PAYEMS. That is deliberate: the eleven
// sectors are not in the catalogue, so taking the total from the database and
// the parts from the live API could put a revised total against unrevised
// parts and break a reconciliation that is supposed to mean something.
// One source, one moment, one vintage.

const { fetchMany } = require('./fred');
const { SUPERSECTORS, buildMix } = require('./payrollMix');

const TOTAL_ID = 'PAYEMS';

// Thirteen months: enough for the latest month, a three-month pace, and room
// for a sector that publishes a month behind the rest.
const WINDOW_MONTHS = 13;

const windowStart = () => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - WINDOW_MONTHS);
  return d.toISOString().slice(0, 10);
};

async function buildPayrollMix() {
  const ids = [...SUPERSECTORS.map(s => s.id), TOTAL_ID];
  const { series, errors } = await fetchMany(ids, { start: windowStart() });

  const obs = (id) => (series[id]?.observations || []).filter(o => String(o.value) !== '.');
  const sectors = Object.fromEntries(SUPERSECTORS.map(s => [s.id, obs(s.id)]));
  const mix = buildMix(sectors, obs(TOTAL_ID));

  if (!mix) {
    return { error: 'no PAYEMS observations available', asOf: new Date().toISOString(), fetchErrors: errors };
  }
  return {
    ...mix,
    source: 'FRED (BLS Current Employment Statistics)',
    seasonallyAdjusted: true,
    // Same revision risk as the headline it decomposes — said here rather than
    // left for the reader to assume monthly sector detail is final.
    revisionNote: 'Sector detail is revised in each of the next two releases and again at the annual benchmark, exactly like the headline.',
    // A series that failed to fetch is already visible as a broken
    // reconciliation; this says which call failed and why.
    fetchErrors: Object.keys(errors).length ? errors : null,
    asOf: new Date().toISOString(),
  };
}

module.exports = { buildPayrollMix };
