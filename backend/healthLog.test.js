const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.HEALTH_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));
const { noteOutcome, noteRecord, readOne, readAll } = require('./healthLog');

test('keeps the last success and the last failure apart, and counts a failing streak', () => {
  noteOutcome('job-x', { ok: true, detail: 'saved 3', at: '2026-11-19T01:00:00Z' });
  noteOutcome('job-x', { ok: false, error: 'boom', at: '2026-11-19T01:30:00Z' });
  let r = noteOutcome('job-x', { ok: false, error: 'boom again', at: '2026-11-19T02:00:00Z' });
  assert.deepEqual([r.lastOk, r.lastOkAt, r.lastError, r.consecutiveFailures, r.lastDetail], [false, '2026-11-19T01:00:00.000Z', 'boom again', 2, 'saved 3']);
  r = noteOutcome('job-x', { ok: true, detail: 'saved 1', at: '2026-11-19T02:30:00Z' });
  assert.deepEqual([r.lastOk, r.consecutiveFailures, r.lastErrorAt], [true, 0, '2026-11-19T02:00:00.000Z']);
});

test('reads records back by prefix, and survives a missing or corrupt file', () => {
  noteRecord('tick-daily-jobs', { ranAt: '2026-11-19T02:30:00Z' });
  fs.writeFileSync(path.join(process.env.HEALTH_LOG_DIR, 'job-broken.json'), '{not json');
  assert.equal(readOne('tick-daily-jobs').ranAt, '2026-11-19T02:30:00Z');
  assert.equal(readOne('does-not-exist'), null);
  assert.deepEqual(Object.keys(readAll('job-')), ['job-x']);
});

test('never throws, even when it cannot write', () => {
  const saved = process.env.HEALTH_LOG_DIR;
  assert.doesNotThrow(() => noteOutcome('../../escape attempt', { ok: true }));
  assert.ok(!fs.existsSync(path.join(saved, '..', '..', 'escape attempt.json')));
});
