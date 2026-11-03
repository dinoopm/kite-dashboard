const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { withRetry } = require('./withRetry');

const noSleep = async () => {};

describe('withRetry', () => {
  test('returns the first success without retrying', async () => {
    let calls = 0;
    const out = await withRetry('[T]', 3, async () => { calls++; return 'ok'; }, { sleep: noSleep, log: () => {} });
    assert.equal(out, 'ok');
    assert.equal(calls, 1);
  });

  // The 2026-11-02 shape: the live-analysis page failed fast once. A second
  // attempt with a fresh browser is the cheapest thing that would have saved
  // the day's movers.
  test('recovers from a transient failure', async () => {
    let calls = 0;
    const out = await withRetry('[T]', 3, async () => {
      calls++;
      if (calls < 2) throw new Error('net::ERR_HTTP2_PROTOCOL_ERROR');
      return 'ok';
    }, { sleep: noSleep, log: () => {} });
    assert.equal(out, 'ok');
    assert.equal(calls, 2);
  });

  // Giving up must stay LOUD. A green run over missing data is the one outcome
  // worse than a red one, so the final error carries every attempt's cause.
  test('throws with every attempt named once all of them fail', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry('[T]', 3, async () => { calls++; throw new Error(`boom ${calls}`); }, { sleep: noSleep, log: () => {} }),
      (err) => {
        assert.match(err.message, /\[T\] failed after 3 attempts/);
        assert.match(err.message, /attempt 1: boom 1/);
        assert.match(err.message, /attempt 3: boom 3/);
        return true;
      },
    );
    assert.equal(calls, 3);
  });

  test('backs off between attempts, longer each time', async () => {
    const waits = [];
    await assert.rejects(withRetry('[T]', 3, async () => { throw new Error('x'); }, {
      sleep: async (ms) => { waits.push(ms); }, log: () => {}, baseDelayMs: 1000,
    }));
    assert.deepEqual(waits, [1000, 2000], 'two waits between three attempts, doubling');
  });

  test('passes the attempt number so a retry can start clean', async () => {
    const seen = [];
    await withRetry('[T]', 3, async (attempt) => { seen.push(attempt); if (attempt < 3) throw new Error('x'); return 1; },
      { sleep: noSleep, log: () => {} });
    assert.deepEqual(seen, [1, 2, 3]);
  });
});
