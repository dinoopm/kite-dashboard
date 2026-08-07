const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { missingInPeriod } = require('./scorecard');

// The two snapshot days dataHealth declares as unrecoverable.
describe('missingInPeriod', () => {
  test('names the lost days when the scored period covers them', () => {
    assert.deepEqual(missingInPeriod('2026-07-01', '2026-08-01'), ['2026-07-16', '2026-07-17']);
  });

  test('says nothing about a period that ends before they fall', () => {
    assert.deepEqual(missingInPeriod('2026-07-01', '2026-07-15'), []);
  });

  test('says nothing about a period that starts after them', () => {
    assert.deepEqual(missingInPeriod('2026-07-18', '2026-08-01'), []);
  });

  // The caveat must not overstate: a period covering one lost day claims one.
  test('reports only the days actually inside the period', () => {
    assert.deepEqual(missingInPeriod('2026-07-17', '2026-08-01'), ['2026-07-17']);
  });
});
