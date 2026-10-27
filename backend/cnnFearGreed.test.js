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
