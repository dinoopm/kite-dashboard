const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { buildPayload, SYSTEM_PROMPT } = require('./narrative');

const MONITOR = {
  anchorDate: '2026-08-09',
  composite: { regime: 'neutral', bias: 'hold-compatible', score: -0.0581, coverage: 1 },
  confidence: { level: 'medium', freshness: 0.833, completeness: 1, agreement: 0.336 },
  signals: {
    inflation: { score: 0.3, detail: { annualized6m: 3.7566 } },
    labour: { score: -0.314 },
    wages: { score: -1 },
    expectations: { score: -0.15 },
    oil: { score: null, reason: 'no oil data' },
  },
  indicators: [
    { scored: true, label: 'Core PCE price index', seriesId: 'PCEPILFE', source: 'BEA', unit: 'Index 2017=100',
      transform: 'index', latest: 130.266, latestDate: '2026-06-01', releasesBehind: 0,
      annualized6m: 3.7566, annualized3m: 2.8851, yoyPct: 3.29, rocPct: 1.86, changePp: null },
    { scored: true, label: 'Unemployment rate', seriesId: 'UNRATE', source: 'BLS', unit: 'Percent',
      transform: 'rate', latest: 4.1, latestDate: '2026-07-01', releasesBehind: 0, changePp: -0.2, rocPct: null },
    { scored: false, label: 'Headline CPI', seriesId: 'CPIAUCSL', source: 'BLS', unit: 'Index',
      transform: 'index', latest: 332.5, latestDate: '2026-06-01', releasesBehind: 0, annualized6m: 4.05 },
  ],
  thresholds: { weights: { inflation: 0.45, labour: 0.25, wages: 0.15, expectations: 0.10, oil: 0.05 } },
  releases: { next: { date: '2026-08-12', title: 'CPI Report', daysAway: 3 }, following: null },
  caveats: ['A bias, not a rate call.'],
};

describe('buildPayload', () => {
  const p = buildPayload(MONITOR);

  // The model must never be able to derive its own six-month figure and
  // disagree with the panel rendered directly above it.
  test('sends no raw observation series', () => {
    const json = JSON.stringify(p);
    assert.ok(!json.includes('observation_date'), 'raw observations leaked into the payload');
    assert.ok(!json.includes('sixMonthsAgo'), 'intermediate lookups leaked into the payload');
  });

  // An index series must not offer a percentage-point field and a rate series
  // must not offer a percent change — otherwise the model quotes whichever
  // reads more dramatically.
  test('offers each indicator only the transform its series supports', () => {
    const pce = p.indicators.find(i => i.seriesId === 'PCEPILFE');
    assert.deepEqual(Object.keys(pce.sixMonth).sort(), ['annualized3mPct', 'annualized6mPct', 'yoyPct']);
    const unrate = p.indicators.find(i => i.seriesId === 'UNRATE');
    assert.deepEqual(Object.keys(unrate.sixMonth), ['changePp']);
    assert.equal(unrate.sixMonth.rocPct, undefined, 'a rate must never be handed a percent change');
  });

  test('excludes the context-only series that is not scored', () => {
    assert.equal(p.indicators.find(i => i.seriesId === 'CPIAUCSL'), undefined);
  });

  test('carries the weights so the model can say what drove the reading', () => {
    assert.equal(p.signals.find(s => s.key === 'inflation').weightPct, 45);
  });

  // A dropped signal must arrive labelled, or the model describes four signals
  // as though they were five.
  test('marks an unavailable signal instead of omitting it', () => {
    const oil = p.signals.find(s => s.key === 'oil');
    assert.equal(oil.score, null);
    assert.equal(oil.unavailable, 'no oil data');
  });

  test('passes the caveats and the upcoming releases through', () => {
    assert.deepEqual(p.caveats, MONITOR.caveats);
    assert.equal(p.upcomingReleases.length, 1);
  });

  test('explains what low agreement means, so it is not read as mildness', () => {
    assert.match(p.confidence.agreementMeaning, /opposite directions/);
  });
});

describe('SYSTEM_PROMPT', () => {
  // The output is a bias. These constraints are the whole reason an LLM is
  // allowed near this panel at all.
  test('forbids inventing numbers, advice and rate certainty', () => {
    assert.match(SYSTEM_PROMPT, /ONLY numbers present in the JSON payload/);
    assert.match(SYSTEM_PROMPT, /Never give investment advice/);
    assert.match(SYSTEM_PROMPT, /Never state what a central bank WILL do/);
  });

  test('requires transforms to be named and conflicts to be kept', () => {
    assert.match(SYSTEM_PROMPT, /percentage-point change a percent change/);
    assert.match(SYSTEM_PROMPT, /name the conflict/i);
  });

  test('requires stale or low-confidence data to be stated up front', () => {
    assert.match(SYSTEM_PROMPT, /confidence is low/);
    assert.match(SYSTEM_PROMPT, /releases? behind/);
  });
});
