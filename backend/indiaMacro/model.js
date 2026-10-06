const { createHash } = require('node:crypto');

const SERIES = {
  repo: { label: 'RBI Repo Rate', unit: '%', frequency: 'policy', maxAgeDays: 3, range: [0, 30] },
  cpi: { label: 'CPI Inflation', unit: '% YoY', frequency: 'monthly', maxAgeDays: 80, range: [-30, 60] },
  gdp: { label: 'Real GDP Growth', unit: '% YoY', frequency: 'quarterly', maxAgeDays: 160, range: [-60, 60] },
  fiscal: { label: 'Fiscal Deficit YTD', unit: 'INR crore', frequency: 'monthly', maxAgeDays: 100, range: [-1e8, 1e8] },
  currentAccount: { label: 'Current Account Balance', unit: '% of GDP', frequency: 'quarterly', maxAgeDays: 190, range: [-30, 30] },
  forex: { label: 'Forex Reserves', unit: 'USD billion', frequency: 'weekly', maxAgeDays: 21, range: [1, 10000] },
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY = 86400000;
function numeric(v) {
  if (v == null || typeof v === 'boolean' || String(v).trim() === '' || !/^-?[\d,]+(?:\.\d+)?$/.test(String(v).trim())) throw new Error('Missing or invalid numeric value');
  const n = Number(String(v).replaceAll(',', ''));
  if (!Number.isFinite(n)) throw new Error('Non-finite numeric value');
  return n;
}
function isoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '') || new Date(s).toISOString().slice(0, 10) !== s) throw new Error('Invalid reference date');
  return s;
}
function dateFromText(s) {
  const m = String(s).match(/([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) throw new Error('Source date not found');
  const month = MONTHS.findIndex(x => x.toLowerCase().startsWith(m[1].toLowerCase()));
  if (month < 0) throw new Error('Unknown source month');
  return isoDate(`${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`);
}
function monthEnd(year, month) { return new Date(Date.UTC(Number(year), Number(month), 0)).toISOString().slice(0, 10); }
function quarterEnd(fy, q) {
  if (!/^\d{4}-\d{2}$/.test(fy) || ![1, 2, 3, 4].includes(Number(q))) throw new Error('Invalid fiscal quarter');
  const start = Number(fy.slice(0, 4));
  return monthEnd(q === 4 ? start + 1 : start, [6, 9, 12, 3][q - 1]);
}
function validateObservation(key, o, now = new Date()) {
  const def = SERIES[key];
  if (!def || !o || typeof o !== 'object') throw new Error('Unknown macro series');
  const value = numeric(o.value);
  const periodEnd = isoDate(o.periodEnd);
  const releaseDate = o.releaseDate ? isoDate(o.releaseDate) : null;
  const today = now.toISOString().slice(0, 10);
  if (periodEnd > today || (releaseDate && (releaseDate > today || releaseDate < periodEnd))) throw new Error('Inconsistent or future source date');
  if (value < def.range[0] || value > def.range[1]) throw new Error('Value outside validation bounds');
  if (!o.referencePeriod || !['actual', 'provisional', 'estimate', 'projection', 'budget'].includes(o.status)) throw new Error('Missing period or estimate status');
  const url = new URL(o.sourceUrl);
  if (url.protocol !== 'https:' || !/(^|\.)(rbi\.org\.in|mospi\.gov\.in|cga\.nic\.in)$/.test(url.hostname)) throw new Error('Expected an official source URL');
  const normalized = { ...o, value, periodEnd, releaseDate, unit: def.unit };
  // Dates of fetching are provenance, never part of the economic revision key.
  const content = { ...normalized };
  delete content.firstSeenAt; delete content.recordedAt; delete content.hash;
  const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  const hash = createHash('sha256').update(JSON.stringify(stable(content))).digest('hex');
  return { ...normalized, hash };
}
function mergeObservations(previous = [], incoming = [], recordedAt) {
  const out = [...previous];
  for (const o of incoming) {
    const existing = [...out].reverse().find(x => x.periodEnd === o.periodEnd);
    if (!existing || existing.hash !== o.hash) out.push({ ...o, firstSeenAt: recordedAt });
  }
  return out.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.firstSeenAt.localeCompare(b.firstSeenAt));
}
function latestObservation(observations = []) { return [...observations].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || b.firstSeenAt.localeCompare(a.firstSeenAt))[0] || null; }
function presentSeries(key, state, now = new Date()) {
  const def = SERIES[key], latest = latestObservation(state?.observations);
  const overdue = !!latest && (now - new Date(latest.periodEnd)) / DAY > def.maxAgeDays;
  const checkOverdue = !state?.lastCheckedAt || (now - new Date(state.lastCheckedAt)) / DAY > 2;
  return {
    key, ...def, latest, lastCheckedAt: state?.lastCheckedAt || null,
    lastSuccessfulCheckAt: state?.lastSuccessfulCheckAt || null,
    error: state?.error || null, overdue, checkOverdue,
    availability: !latest ? 'unavailable' : state?.error || overdue || checkOverdue ? 'stale' : 'available',
    revisionCount: latest ? state.observations.filter(o => o.periodEnd === latest.periodEnd).length - 1 : 0,
    recentRevisions: latest ? state.observations.filter(o => o.periodEnd === latest.periodEnd).slice(-4) : [],
  };
}
module.exports = { SERIES, MONTHS, numeric, isoDate, dateFromText, monthEnd, quarterEnd, validateObservation, mergeObservations, latestObservation, presentSeries };
