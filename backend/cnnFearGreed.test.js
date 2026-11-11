const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCnn, createCnnService } = require('./cnnFearGreed');
const sample = { fear_and_greed: { score: 0, rating: 'extreme fear', timestamp: '2026-10-26T23:59:53Z', previous_close: 10, previous_1_week: null } };
test('CNN parser preserves source ratings, zero scores, missing comparisons and timestamps', () => {
  const data = parseCnn(sample); assert.equal(data.score, 0); assert.equal(data.rating, 'extreme fear'); assert.equal(data.oneWeekAgo, null);
  assert.throws(() => parseCnn({ fear_and_greed: { ...sample.fear_and_greed, score: 101 } }));
  assert.throws(() => parseCnn({ fear_and_greed: { ...sample.fear_and_greed, timestamp: null } }));
});
test('CNN rejection returns an explicitly saved reading, never a fresh update time', async () => {
  const saved = { score: 27, rating: 'fear', asOf: '2026-10-26T23:59:53.000Z' };
  let calls = 0;
  const get = createCnnService({ saved, fetchData: async () => { calls++; throw Error('418'); }, now: () => new Date('2026-10-27T01:00:00Z') });
  const [a, b] = await Promise.all([get(), get()]); assert.equal(a.mode, 'saved'); assert.equal(a.asOf, saved.asOf); assert.equal(b.score, 27); assert.equal(calls, 1);
});
test('an old or future feed response cannot replace the saved reading', async () => {
  for (const timestamp of ['2026-10-20T00:00:00Z', '2026-11-01T00:00:00Z']) {
    const get = createCnnService({ fetchData: async () => ({ fear_and_greed: { ...sample.fear_and_greed, timestamp } }), now: () => new Date('2026-10-27T01:00:00Z') });
    assert.equal((await get()).mode, 'saved');
  }
});

// The page showed an Oct 26 reading on Nov 3 as its headline, because the
// feed has been refused (418) and the only fallback was a file committed to
// the repo. Two fixes, tested separately: the last LIVE reading now survives a
// restart, and any reading old enough to mislead says so in the payload.
const committed = { score: 27, rating: 'fear', asOf: '2026-10-26T23:59:53.000Z' };
test('a reading days old is marked stale with its age, from whichever source', async () => {
  const get = createCnnService({ saved: committed, fetchData: async () => { throw Error('418'); }, now: () => new Date('2026-11-03T14:24:00Z') });
  const r = await get();
  assert.equal(r.mode, 'saved');
  assert.equal(r.stale, true);
  assert.equal(r.ageDays, 8);
});
test('a same-day reading is not stale', async () => {
  const get = createCnnService({ saved: committed, fetchData: async () => { throw Error('418'); }, now: () => new Date('2026-10-27T01:00:00Z') });
  const r = await get();
  assert.equal(r.stale, false);
  assert.equal(r.ageDays, 0);
});
test('a weekend does not make a Friday reading stale', async () => {
  const friday = { score: 40, rating: 'fear', asOf: '2026-10-30T20:00:00.000Z' };
  const get = createCnnService({ saved: friday, fetchData: async () => { throw Error('418'); }, now: () => new Date('2026-11-02T13:00:00Z') });
  assert.equal((await get()).stale, false);
});
test('the last live reading survives a restart instead of reverting to the committed file', async () => {
  let stored = null;
  const store = { read: () => stored, write: (r) => { stored = r; } };
  const live = { fear_and_greed: { score: 41, rating: 'fear', timestamp: '2026-11-02T20:00:00Z', previous_close: 38 } };
  const first = createCnnService({ saved: committed, store, fetchData: async () => live, now: () => new Date('2026-11-02T21:00:00Z') });
  assert.equal((await first()).mode, 'feed');
  const afterRestart = createCnnService({ saved: committed, store, fetchData: async () => { throw Error('418'); }, now: () => new Date('2026-11-03T14:00:00Z') });
  const r = await afterRestart();
  assert.equal(r.mode, 'saved');
  assert.equal(r.score, 41);
  assert.equal(r.asOf, '2026-11-02T20:00:00.000Z');
});
test('a stored reading older than the committed one never wins', async () => {
  const store = { read: () => ({ score: 55, rating: 'neutral', asOf: '2026-10-20T20:00:00.000Z' }), write: () => {} };
  const get = createCnnService({ saved: committed, store, fetchData: async () => { throw Error('418'); }, now: () => new Date('2026-10-27T01:00:00Z') });
  assert.equal((await get()).score, 27);
});
test('a corrupt stored reading is ignored', async () => {
  const store = { read: () => ({ nonsense: true }), write: () => {} };
  const get = createCnnService({ saved: committed, store, fetchData: async () => { throw Error('418'); }, now: () => new Date('2026-10-27T01:00:00Z') });
  assert.equal((await get()).score, 27);
});
