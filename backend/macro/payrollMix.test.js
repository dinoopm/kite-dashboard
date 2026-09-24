const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { SUPERSECTORS, buildMix } = require('./payrollMix');

// August 2026 as published: the eleven supersectors and the total they must add
// up to. Real numbers, because the reconciliation is the whole point — a
// breakdown that does not sum to the headline is describing a different
// universe from the one the panel scores.
const LEVELS = {
  USMINE: [606, 606, 606, 609],
  USCONS: [8316, 8323, 8337, 8359],
  MANEMP: [12595, 12610, 12622, 12638],
  USTPU: [28724, 28745, 28762, 28778],
  USINFO: [2782, 2771, 2768, 2745],
  USFIRE: [9106, 9100, 9097, 9086],
  USPBS: [22466, 22489, 22517, 22527],
  USEHS: [27883, 27915, 27945, 27974],
  USLAH: [17014, 16955, 16939, 17001],
  USSERV: [6031, 6031, 6032, 6035],
  USGOVT: [23333, 23299, 23288, 23323],
};
const MONTHS = ['2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01'];
const obs = (values) => values.map((v, i) => ({ observation_date: MONTHS[i], value: v }));
const sectors = Object.fromEntries(Object.entries(LEVELS).map(([id, v]) => [id, obs(v)]));
const total = obs([158882, 158844, 158913, 159075]);

describe('SUPERSECTORS', () => {
  test('is the exhaustive CES split, so the parts can be checked against the whole', () => {
    assert.equal(SUPERSECTORS.length, 11);
    const ids = SUPERSECTORS.map(s => s.id);
    assert.equal(new Set(ids).size, 11, 'no duplicates');
    assert.ok(ids.includes('USGOVT') && ids.includes('MANEMP') && ids.includes('USEHS'));
  });
});

describe('buildMix', () => {
  const mix = buildMix(sectors, total);

  test('reports the month the breakdown describes', () => {
    assert.equal(mix.month, '2026-08-01');
  });

  test('gives each sector its level, monthly change and three-month pace', () => {
    const lah = mix.rows.find(r => r.id === 'USLAH');
    assert.equal(lah.level, 17001);
    assert.equal(lah.change1m, 62);
    // (17001 - 17014) / 3
    assert.ok(Math.abs(lah.avg3m - (-13 / 3)) < 1e-9);
  });

  test('sorts by the monthly change, so the drivers read first', () => {
    assert.equal(mix.rows[0].id, 'USLAH');
    assert.equal(mix.rows.at(-1).id, 'USINFO');
  });

  // The check that makes the table trustworthy: eleven mutually exclusive
  // sectors must add to total nonfarm, in level AND in change.
  test('reconciles the parts against the headline', () => {
    assert.equal(mix.reconciliation.sumLevel, 159075);
    assert.equal(mix.reconciliation.totalLevel, 159075);
    assert.equal(mix.reconciliation.sumChange1m, 162);
    assert.equal(mix.reconciliation.totalChange1m, 162);
    assert.equal(mix.reconciliation.ok, true);
  });

  test('fails the reconciliation loudly when a sector is missing', () => {
    const { USGOVT, ...withoutGovernment } = sectors;
    const m = buildMix(withoutGovernment, total);
    assert.equal(m.reconciliation.ok, false);
    assert.match(m.reconciliation.reason, /USGOVT/);
    assert.equal(m.reconciliation.sumLevel, null, 'a subset must not be presented as if it summed to the whole');
  });

  // A sector one release behind would otherwise contribute a change measured
  // over a different month than the rest of the table.
  test('fails the reconciliation when a sector is on an older month', () => {
    const lagged = { ...sectors, USINFO: obs(LEVELS.USINFO).slice(0, 3) };
    const m = buildMix(lagged, total);
    assert.equal(m.reconciliation.ok, false);
    assert.match(m.reconciliation.reason, /USINFO/);
    const info = m.rows.find(r => r.id === 'USINFO');
    assert.equal(info.stale, true);
    assert.equal(info.month, '2026-07-01', 'and the row says which month it is actually showing');
  });

  test('says nothing at all when the headline series is missing', () => {
    assert.equal(buildMix(sectors, []), null);
    assert.equal(buildMix(sectors, null), null);
  });

  test('leaves a three-month pace null rather than inventing one from short history', () => {
    const short = Object.fromEntries(Object.entries(sectors).map(([id, o]) => [id, o.slice(-2)]));
    const m = buildMix(short, total.slice(-2));
    assert.equal(m.rows[0].avg3m, null);
    assert.ok(Number.isFinite(m.rows[0].change1m), 'but the monthly change still computes');
  });
});
