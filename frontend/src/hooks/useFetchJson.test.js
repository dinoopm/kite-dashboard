import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readResult, toResult } from './useFetchJson.js'

describe('readResult', () => {
  test('a URL with no stored answer is loading, with nothing to show', () => {
    assert.deepEqual(readResult(null, '/api/a'), { data: null, error: null, loading: true })
  })
  // The case the hand-written copies got wrong if a response arrived late:
  // switching AAPL → MSFT must never show AAPL's numbers under MSFT.
  test('an answer for a different URL is not shown; the new one is loading', () => {
    const stored = { url: '/api/us/pnl/AAPL', data: { revenue: 1 }, error: null }
    assert.deepEqual(readResult(stored, '/api/us/pnl/MSFT'), { data: null, error: null, loading: true })
  })
  test('the answer for this URL is shown', () => {
    assert.deepEqual(readResult({ url: '/api/a', data: [1], error: null }, '/api/a'), { data: [1], error: null, loading: false })
    assert.deepEqual(readResult({ url: '/api/a', data: null, error: 'boom' }, '/api/a'), { data: null, error: 'boom', loading: false })
  })
  test('no URL means nothing was asked for', () => {
    assert.deepEqual(readResult({ url: '/api/a', data: 1, error: null }, null), { data: null, error: null, loading: false })
  })
})

describe('toResult', () => {
  test('an ok JSON body is data', () => {
    assert.deepEqual(toResult('/u', { ok: true, status: 200, body: { x: 1 } }), { url: '/u', data: { x: 1 }, error: null })
  })
  test('a body with an error field is an error, whatever the status', () => {
    assert.deepEqual(toResult('/u', { ok: true, status: 200, body: { error: 'no data' } }).error, 'no data')
    assert.deepEqual(toResult('/u', { ok: false, status: 502, body: { error: 'upstream' } }).error, 'upstream')
  })
  // Some copies used to hand an error page's body to the UI as if it were data.
  test('an HTTP error without a message is an error, never data', () => {
    assert.deepEqual(toResult('/u', { ok: false, status: 500, body: null }), { url: '/u', data: null, error: 'HTTP 500' })
    assert.deepEqual(toResult('/u', { ok: false, status: 404, body: { rows: [] } }), { url: '/u', data: null, error: 'HTTP 404' })
  })
  test('an empty ok body is no data, not an error', () => {
    assert.deepEqual(toResult('/u', { ok: true, status: 200, body: null }), { url: '/u', data: null, error: null })
  })
})
