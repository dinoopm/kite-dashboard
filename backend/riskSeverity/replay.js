const { severityAt, RULES, completedCutoff } = require('../usRiskSeverity');
const { assess } = require('./classify');
const { validateThresholds } = require('./thresholds.ts');
const { configFingerprint } = require('./validation');
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const timestamp = value => typeof value === 'string' && /T.*(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const SYMBOLS = ['SPY', 'TLT', 'VIX', 'HY_OAS'];
const EPISODES = [
  ['2008 GFC', '2007-10-01', '2009-06-30'], ['2011 euro crisis', '2011-07-01', '2011-12-30'],
  ['2015–16 energy/China', '2015-06-01', '2016-03-31'], ['Feb 2018 volmageddon', '2018-02-01', '2018-03-01'],
  ['Dec 2018', '2018-10-01', '2018-12-31'], ['2020 COVID', '2020-02-01', '2020-04-30'], ['2022 bear market', '2022-01-01', '2022-12-30'],
];
function validateDataset(dataset) {
  if (dataset.schemaVersion !== 1 || dataset.provenance?.kind !== 'point-in-time' || !dataset.provenance?.source || !dataset.provenance?.calendarSource) throw Error('A documented point-in-time archive with an exchange-session calendar is required. Current history is not a vintage archive.');
  if (!Array.isArray(dataset.sessions) || !dataset.sessions.length) throw Error('Missing exchange sessions');
  const seen = new Set();
  for (const session of dataset.sessions) {
    if (!isoDate(session.date) || seen.has(session.date) || !timestamp(session.closeAt) || !timestamp(session.openAt) || Date.parse(session.openAt) >= Date.parse(session.closeAt) || !(session.spyOpen > 0) || !(session.spyClose > 0)) throw Error(`Invalid or duplicate exchange session: ${session.date}`);
    if (session.openAt.slice(0, 10) !== session.date || session.closeAt.slice(0, 10) !== session.date) throw Error(`Session timestamp date mismatch: ${session.date}`);
    seen.add(session.date);
  }
  for (const symbol of SYMBOLS) if (!Array.isArray(dataset.observations?.[symbol]) || !dataset.observations[symbol].length) throw Error(`Missing vintage series: ${symbol}`);
  for (const [symbol, rows] of Object.entries(dataset.observations)) for (const row of rows) {
    if (!isoDate(row.date) || !timestamp(row.availableAt) || !row.vintage || !row.source || !(Number.isFinite(row.value) && (symbol.endsWith('OAS') ? row.value >= 0 : row.value > 0))) throw Error(`Invalid vintage observation in ${symbol}: ${row.date}`);
    if (row.availableAt.slice(0, 10) < row.date) throw Error(`Availability precedes observation in ${symbol}: ${row.date}`);
  }
  return dataset;
}
function versionCursor(rows = []) {
  const versions = [...rows].sort((a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt));
  const visible = new Map(); let cursor = 0;
  return { visible, advance(timestamp) {
    while (cursor < versions.length && Date.parse(versions[cursor].availableAt) <= timestamp) {
      const item = versions[cursor++];
      const previous = visible.get(item.date);
      if (previous && previous.availableAt === item.availableAt && previous.value !== item.value) throw Error(`Conflicting vintages at ${item.availableAt}`);
      visible.set(item.date, item);
    }
  } };
}
function reconstruct(dataset, config = RULES, { start = '2007-01-01', end = completedCutoff(new Date(), config) } = {}) {
  validateThresholds(config); validateDataset(dataset);
  const calendar = [...dataset.sessions].sort((a, b) => a.date.localeCompare(b.date));
  const cursors = Object.fromEntries([...SYMBOLS, 'CCC_OAS'].map(symbol => [symbol, versionCursor(dataset.observations[symbol])]));
  const rows = [];
  for (let i = 0; i < calendar.length; i++) {
    const session = calendar[i]; if (session.date > end) break;
    const timestamp = Date.parse(session.closeAt);
    for (const cursor of Object.values(cursors)) cursor.advance(timestamp);
    if (session.date < start) continue;
    const basisIndex = calendar.findLastIndex((p, index) => index <= i && SYMBOLS.every(symbol => cursors[symbol].visible.has(p.date)));
    const basis = calendar[basisIndex];
    let metrics = { vix: null, rotation: null, drawdown: null, rapidDrawdown: null, creditChange21: null, creditChange4: null };
    let vintages = [];
    if (basis) {
      const prices = calendar.slice(0, basisIndex + 1).map(p => ({ date: p.date, value: cursors.SPY.visible.get(p.date)?.value }));
      const mapValues = symbol => new Map([...cursors[symbol].visible].map(([date, point]) => [date, point.value]));
      const required = Math.max(config.highSessions, config.rotationSessions + 1, config.rapidSessions + 1);
      if (prices.length >= required && prices.slice(-required).every(p => Number.isFinite(p.value) && p.value > 0)) {
        metrics = severityAt(prices, mapValues('TLT'), mapValues('VIX'), mapValues('HY_OAS'), basisIndex, config, mapValues('CCC_OAS')).metrics;
      }
      vintages = [...SYMBOLS, 'CCC_OAS'].map(symbol => {
        const item = cursors[symbol].visible.get(basis.date);
        return { symbol, observationDate: basis.date, availableAt: item?.availableAt || null, vintage: item?.vintage || null, source: item?.source || null };
      });
    }
    const stale = Boolean(basis && (Date.parse(session.date) - Date.parse(basis.date)) / 864e5 > config.staleDays);
    const assessment = assess({ ...metrics, stale }, config);
    rows.push({ date: session.date, openAt: session.openAt, closeAt: session.closeAt, spyOpen: session.spyOpen, spyClose: session.spyClose,
      basisDate: basis?.date || null, tier: assessment.state, metrics, flags: Object.fromEntries(assessment.flags.map(f => [f.id, f.triggered])), vintages });
  }
  return { rows, start, end, configFingerprint: configFingerprint(config), provenance: 'point-in-time' };
}
function coverageFor(rows, { start, end }) {
  const good = rows.filter(row => row.tier !== 'INCOMPLETE');
  const episodes = EPISODES.map(([name, from, to]) => {
    const sample = rows.filter(row => row.date >= from && row.date <= to);
    const missing = sample.filter(row => row.tier === 'INCOMPLETE').length;
    return { name, from, to, sessions: sample.length, missing, covered: sample.length > 0 && !missing && Date.parse(sample[0].date) - Date.parse(from) <= 7 * 864e5 && Date.parse(to) - Date.parse(sample.at(-1).date) <= 7 * 864e5 };
  });
  const missing = rows.length - good.length;
  const complete = Boolean(rows.length && !missing && rows[0].date <= '2007-01-07' && Date.parse(end) - Date.parse(rows.at(-1).date) <= 3 * 864e5 && start <= '2007-01-01' && episodes.every(e => e.covered));
  return { complete, start, end, first: rows[0]?.date || null, last: rows.at(-1)?.date || null, sessions: rows.length, incompleteSessions: missing, episodes };
}
module.exports = { EPISODES, SYMBOLS, validateDataset, versionCursor, reconstruct, coverageFor };
