const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { indiaNoteFor } = require('./riskRegime');

// The note once claimed a 10Y of "~4.75%+ historically triggers FII selling".
// The app's own FII data showed no such level (see indiaNoteFor), so the note
// must state the mechanism without promising what flows will do at any yield.
test('the India note names the yield without asserting a trigger level', () => {
  for (const y of [3.9, 4.74, 4.75, 5.14, 6.2]) {
    const note = indiaNoteFor(y);
    assert.match(note, new RegExp(`US 10Y at ${y}%`));
    // Checked without the yield figure itself, which is 4.75 for one input.
    const claim = note.replace(/US 10Y at [\d.]+%/, '');
    assert.doesNotMatch(claim, /zone|historically triggers|tend to accelerate|4\.75/, note);
    assert.doesNotMatch(claim, /\bwill\b|\bexpect|\blikely\b/i, note);
  }
});

test('the note reads the same above and below the old threshold', () => {
  const strip = (s) => s.replace(/US 10Y at [\d.]+%/, '');
  assert.equal(strip(indiaNoteFor(4.5)), strip(indiaNoteFor(5.14)));
});

const { scoreRegime, regimeHistory, regimeRuns, sinceFor, sessionComplete, RULES, RULE_VERSION } = require('./riskRegime');

test('scoreRegime: each gauge is −1/0/+1 against its band, and two agreeing gauges decide', () => {
  // The 12 Nov 2026 read: yield −0.09pp and stocks-vs-bonds −2.67pp past their
  // bands, credit inside its band.
  assert.deepEqual(scoreRegime({ yield1mo: -0.09, spyTlt1mo: -2.67, hygLqd1mo: -0.16 }),
    { scores: { yield: -1, stocksBonds: -1, credit: 0 }, score: -2, label: 'RISK-OFF' });
  // 13 Nov: everything back inside.
  assert.equal(scoreRegime({ yield1mo: 0.07, spyTlt1mo: -1.52, hygLqd1mo: 0.42 }).label, 'NEUTRAL');
  assert.equal(scoreRegime({ yield1mo: 0.3, spyTlt1mo: 6, hygLqd1mo: 0 }).label, 'RISK-ON');
  // A band edge is still inside the band.
  assert.equal(scoreRegime({ yield1mo: RULES.yieldBandPp, spyTlt1mo: 0, hygLqd1mo: 0 }).scores.yield, 0);
  // One strong gauge against two quiet ones is not a regime.
  assert.equal(scoreRegime({ yield1mo: -1, spyTlt1mo: 0, hygLqd1mo: 0 }).label, 'NEUTRAL');
});

test('the rule version follows the rules, not this file', () => {
  assert.match(RULE_VERSION, /^risk-regime-[0-9a-f]{16}$/);
});

// Synthetic closes: n business days from 1 Sep 2026, each symbol following f(i).
function series(n, f) {
  const out = []; const d = new Date(Date.UTC(2026, 8, 1));
  while (out.length < n) {
    if (d.getUTCDay() % 6 !== 0) out.push({ date: d.toISOString().slice(0, 10), close: f(out.length) });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const flat = (v) => () => v;
const LATE = new Date('2026-12-31T23:00:00Z');

describe('regimeHistory', () => {
  test('replays the same rule per session over a 21-session window', () => {
    // Bonds rally (yield falls 1bp a session, TLT rises), stocks flat, junk lags: risk-off throughout.
    const n = 40;
    const h = regimeHistory({
      tnx: series(n, i => 5 - i * 0.01), spy: series(n, flat(100)), tlt: series(n, i => 90 + i * 0.2),
      hyg: series(n, flat(80)), lqd: series(n, i => 110 + i * 0.1),
    }, { now: LATE });
    assert.equal(h.length, n - RULES.windowSessions);
    assert.ok(h.every(x => x.label === 'RISK-OFF'), JSON.stringify(h.at(-1)));
    assert.equal(h.at(-1).yield1mo, -0.21);
  });

  test('drops a date any series is missing, rather than mixing days', () => {
    const n = 30;
    const tnx = series(n, flat(5)).filter((_, i) => i !== 25); // a bond-market holiday
    const h = regimeHistory({ tnx, spy: series(n, flat(1)), tlt: series(n, flat(1)), hyg: series(n, flat(1)), lqd: series(n, flat(1)) }, { now: LATE });
    assert.equal(h.length, n - 1 - RULES.windowSessions);
    assert.ok(!h.some(x => x.date === series(n, flat(1))[25].date));
  });

  test('leaves out a session that is still trading', () => {
    const s = series(25, flat(1));
    const last = s.at(-1).date;
    const midSession = new Date(`${last}T17:00:00Z`); // 12:00–13:00 ET
    const all = { tnx: s, spy: s, tlt: s, hyg: s, lqd: s };
    assert.ok(!regimeHistory(all, { now: midSession }).some(x => x.date === last));
    assert.ok(regimeHistory(all, { now: LATE }).some(x => x.date === last));
  });

  test('keeps only the last N sessions', () => {
    const s = series(100, flat(1));
    assert.equal(regimeHistory({ tnx: s, spy: s, tlt: s, hyg: s, lqd: s }, { now: LATE, sessions: 60 }).length, 60);
  });
});

test('sessionComplete waits for the close in New York, not UTC', () => {
  assert.equal(sessionComplete('2026-11-13', new Date('2026-11-13T20:00:00Z')), false); // 15:00 EST
  assert.equal(sessionComplete('2026-11-13', new Date('2026-11-13T21:20:00Z')), true);  // 16:20 EST
  assert.equal(sessionComplete('2026-11-12', new Date('2026-11-13T14:00:00Z')), true);
});

describe('regimeRuns / sinceFor', () => {
  const h = (labels) => labels.map((label, i) => ({ date: `2026-10-${String(10 + i).padStart(2, '0')}`, label }));

  test('groups consecutive labels', () => {
    assert.deepEqual(regimeRuns(h(['NEUTRAL', 'RISK-OFF', 'RISK-OFF', 'NEUTRAL'])).map(r => [r.label, r.sessions]),
      [['NEUTRAL', 1], ['RISK-OFF', 2], ['NEUTRAL', 1]]);
  });

  test('says since when and what came before', () => {
    const s = sinceFor(h(['RISK-ON', 'RISK-OFF', 'RISK-OFF', 'NEUTRAL']), 'NEUTRAL');
    assert.equal(s.since, '2026-10-13');
    assert.deepEqual([s.previous.label, s.previous.from, s.previous.to], ['RISK-OFF', '2026-10-11', '2026-10-12']);
    assert.equal(s.atLeast, false);
  });

  test('a word that changed today has no settled start yet', () => {
    const s = sinceFor(h(['RISK-OFF', 'RISK-OFF']), 'NEUTRAL');
    assert.equal(s.since, null);
    assert.equal(s.previous.label, 'RISK-OFF');
  });

  test('a run filling the whole strip is reported as at least that long', () => {
    assert.equal(sinceFor(h(['NEUTRAL', 'NEUTRAL']), 'NEUTRAL').atLeast, true);
  });
});
