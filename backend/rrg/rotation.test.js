const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { quadrantEntries, scoreRotation, entriesForWeek, headlineFor, signalName, MIN_N, MIN_WEEKS } = require('./rotation');

const wk = (i) => { const d = new Date(Date.UTC(2024, 0, 5 + 7 * i)); return d.toISOString().slice(0, 10); };
const pts = (list) => list.map(([rsRatio, rsMomentum], i) => ({ date: wk(i), rsRatio, rsMomentum }));
const L = [101, 101], W = [101, 99], G = [99, 99], I = [99, 101];

describe('quadrantEntries', () => {
  test('fires on the week a sector enters a quadrant, once', () => {
    const e = quadrantEntries(pts([G, G, G, G, I, I, I, L, L, L]));
    assert.deepEqual(e.map(x => [x.date, x.from, x.to]), [[wk(4), 'Lagging', 'Improving'], [wk(7), 'Improving', 'Leading']]);
  });
  // The same fact restated: a sector wobbling across a line.
  test('a re-entry inside the cooldown is not a new entry', () => {
    const e = quadrantEntries(pts([G, G, G, G, L, G, L, G, L, L]));
    assert.deepEqual(e.map(x => [x.date, x.to]), [[wk(4), 'Leading']]);
  });
  test('cannot fire before the cooldown has history to look back on', () => {
    assert.deepEqual(quadrantEntries(pts([G, L, L, L])), []);
  });
});

describe('headlineFor', () => {
  const row = (o) => [{ horizon: '8w', n: 100, medianExcessPct: 0, hitRateExcessPct: 50, ...o }];
  const opts = { benchmark: 'SPY', weeks: 100, source: 'reconstructed' };

  test('refuses to speak on a small sample, or one squeezed into few weeks', () => {
    assert.equal(headlineFor(row({ n: MIN_N - 1 }), { ...opts, direction: 'bullish' }).state, 'thin');
    assert.match(headlineFor(row({ n: 60 }), { ...opts, weeks: MIN_WEEKS - 1, direction: 'bullish' }).text, /too few to judge/);
    assert.equal(headlineFor(row({ n: 0 }), { ...opts, direction: 'bullish' }).state, 'no-data');
  });
  // The US result: +0.07% median, 50.5% beat, over 154 weeks. Not a finding.
  test('a beat-rate a coin would produce is "no clear edge", in grey, whatever the sign', () => {
    const h = headlineFor(row({ n: 194, medianExcessPct: 0.07, hitRateExcessPct: 50.5 }), { ...opts, weeks: 154, direction: 'bullish' });
    assert.equal(h.state, 'thin');
    assert.match(h.text, /^no clear edge/);
    assert.match(h.detail, /not distinguishable from chance/);
  });
  test('a real bullish edge is positive, a real bullish miss negative', () => {
    assert.equal(headlineFor(row({ medianExcessPct: 1.2, hitRateExcessPct: 62 }), { ...opts, direction: 'bullish' }).state, 'positive');
    assert.equal(headlineFor(row({ medianExcessPct: -1.2, hitRateExcessPct: 38 }), { ...opts, direction: 'bullish' }).state, 'negative');
  });
  // A warning that worked must never be painted the colour that means "beat the index".
  test('a warning that held is "held", never positive; one that failed is "refuted"', () => {
    assert.equal(headlineFor(row({ medianExcessPct: -1.5, hitRateExcessPct: 37 }), { ...opts, direction: 'bearish' }).state, 'held');
    assert.equal(headlineFor(row({ medianExcessPct: 1.5, hitRateExcessPct: 63 }), { ...opts, direction: 'bearish' }).state, 'refuted');
  });
  test('says which kind of evidence it is', () => {
    assert.match(headlineFor(row({ medianExcessPct: 1.2, hitRateExcessPct: 62 }), { ...opts, direction: 'bullish' }).detail, /Reconstructed/);
    assert.match(headlineFor(row({ medianExcessPct: 1.2, hitRateExcessPct: 62 }), { ...opts, source: 'recorded', direction: 'bullish' }).detail, /Recorded the week it happened/);
  });
});

// Deterministic daily bars: a benchmark drifting up, sectors wandering around it.
function universe(nDays = 1100) {
  let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  const dates = []; const d = new Date('2021-01-04T05:00:00Z');
  while (dates.length < nDays) { if (d.getUTCDay() % 6 !== 0) dates.push(d.toISOString()); d.setUTCDate(d.getUTCDate() + 1); }
  const walk = (drift, vol) => { let p = 100, v = 0; return dates.map(date => { v = v * 0.97 + rnd() * vol; p *= 1 + drift + v; return { date, close: p, low: p * 0.99, high: p * 1.01 }; }); };
  return { bench: walk(0.0003, 0.004), sectors: { AAA: walk(0.0003, 0.012), BBB: walk(0.0002, 0.012), CCC: walk(0.0004, 0.012) }, last: dates.at(-1) };
}

describe('scoreRotation', () => {
  const u = universe();
  const now = new Date('2030-01-01T00:00:00Z');
  const out = scoreRotation(u.sectors, u.bench, { market: 'US', benchmark: 'SPY', now });

  test('scores each quadrant twice — reconstructed and recorded — and never pools them', () => {
    assert.equal(out.signals.length, 8);
    for (const q of ['leading', 'weakening', 'lagging', 'improving']) {
      const both = out.signals.filter(s => s.signal === `us_rrg_enter_${q}`);
      assert.deepEqual(both.map(s => s.source).sort(), ['reconstructed', 'recorded']);
      assert.equal(both.find(s => s.source === 'recorded').firings, 0);
      assert.equal(both.find(s => s.source === 'recorded').headline.state, 'no-data');
    }
    assert.ok(out.signals.filter(s => s.source === 'reconstructed').some(s => s.firings > 0));
  });

  test('recorded rows are scored on their own', () => {
    const anEntry = scoreRotation(u.sectors, u.bench, { now }).signals.find(s => s.source === 'reconstructed' && s.firings > 0);
    const first = { signal: anEntry.signal, symbol: 'AAA', date: anEntry.firstFired };
    const withRec = scoreRotation(u.sectors, u.bench, { now, recorded: [first] });
    assert.equal(withRec.signals.find(s => s.signal === anEntry.signal && s.source === 'recorded').firings, 1);
    assert.equal(withRec.signals.find(s => s.signal === anEntry.signal && s.source === 'reconstructed').firings, anEntry.firings);
  });

  test('a week still trading is not scored, and not recorded', () => {
    const midWeek = new Date(new Date(u.last).getTime() + 3600 * 1000);
    const live = scoreRotation(u.sectors, u.bench, { now: midWeek });
    assert.ok(live.coverage.lastWeek < out.coverage.lastWeek || new Date(u.last).getUTCDay() === 5);
    const lastDone = live.coverage.lastWeek;
    for (const e of entriesForWeek(u.sectors, u.bench, lastDone, { now: midWeek })) assert.equal(e.date, lastDone);
    // Asking for an older week than the last completed one returns nothing: a recorder must not look back.
    assert.deepEqual(entriesForWeek(u.sectors, u.bench, '2022-01-07', { now }), []);
  });

  test('names follow the registry', () => {
    assert.equal(signalName('US', 'Leading'), 'us_rrg_enter_leading');
    assert.ok(require('../signals/registry').signalMeta('us_rrg_enter_lagging'));
  });
});
