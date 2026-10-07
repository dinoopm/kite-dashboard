import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildIndexComparison } from './indexComparison.js'
import { US_COMPARISON_INDICES, usBarsUrl, parseUsComparisonBars, fetchUsComparisonBars } from './usIndexComparison.js'

const bar = (day, close) => ({ date: `2026-09-${day}T04:00:00Z`, close, open: close - 1, volume: 123 })

test('US benchmarks use the existing ETF proxies and identical range/session requests', () => {
  assert.deepEqual(US_COMPARISON_INDICES.map(index => index.symbol), ['SPY', 'QQQ', 'IWM'])
  for (const range of ['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y', '2Y', '3Y', '5Y']) {
    assert.equal(usBarsUrl('QQQ', range), `/api/us/bars/QQQ?range=${range}`)
  }
  assert.equal(usBarsUrl('IWM', '1D', true), '/api/us/bars/IWM?range=1D&extended=1')
  assert.equal(usBarsUrl('IWM', '1Y', true), '/api/us/bars/IWM?range=1Y')
  assert.equal(usBarsUrl('BRK/B', '1M'), '/api/us/bars/BRK%2FB?range=1M')
})

test('all US lines start at zero on the shared session; stock volume and prices remain unchanged', () => {
  const stock = [bar('01', 100), bar('02', 110), bar('03', 120)]
  const original = structuredClone(stock)
  const result = buildIndexComparison(stock, {
    sp500: [bar('01', 600), bar('02', 612), bar('03', 630)],
    nasdaq100: [bar('01', 500), bar('02', 525), bar('03', 550)],
    russell2000: [bar('01', 200), bar('02', 198), bar('03', 204)],
  })
  for (const key of ['stockReturn', ...result.indices]) assert.equal(result.data[0][key], 0)
  assert.ok(Math.abs(result.data[2].stockReturn - 20) < 1e-10)
  assert.ok(Math.abs(result.data[2].sp500 - 5) < 1e-10)
  assert.ok(Math.abs(result.data[2].nasdaq100 - 10) < 1e-10)
  assert.ok(Math.abs(result.data[2].russell2000 - 2) < 1e-10)
  assert.equal(result.data[2].volume, 123)
  assert.equal(result.data[2].close, 120)
  assert.deepEqual(stock, original)
  assert.equal(buildIndexComparison(stock, {}).base, null)
  assert.deepEqual(buildIndexComparison(stock, {}).data, original)
})

test('late starts, missing sessions and stale benchmark tails stay explicit', () => {
  const result = buildIndexComparison([bar('01', 100), bar('02', 110), bar('03', 120), bar('04', 125)], {
    sp500: [bar('02', 600), bar('04', 630)],
    russell2000: [bar('02', 200), bar('03', 210)],
  })
  assert.equal(result.base, 110)
  assert.equal(result.shortened, true)
  assert.equal(result.data[1].sp500, null)
  assert.equal(result.data[2].russell2000, null)
  assert.deepEqual(result.endMissing, ['russell2000'])
})

test('intraday matches absolute timestamps including extended hours over UTC midnight', () => {
  const stock = [
    { date: '2026-09-01T09:30:00-04:00', close: 100 },
    { date: '2026-09-01T09:45:00-04:00', close: 105 },
    { date: '2026-09-01T19:45:00-04:00', close: 110 },
  ]
  const result = buildIndexComparison(stock, { sp500: [
    { date: '2026-09-01T13:30:00Z', close: 600 },
    { date: '2026-09-01T23:45:00Z', close: 630 },
  ] }, true)
  assert.equal(result.data[0].sp500, 0)
  assert.equal(result.data[1].sp500, null)
  assert.ok(Math.abs(result.data[2].sp500 - 5) < 1e-10)
  assert.equal(buildIndexComparison(stock, { sp500: [{ date: '2026-09-02T13:30:00Z', close: 600 }] }, true).base, null)
})

test('malformed, empty and invalid US responses fail visibly instead of drawing misleading returns', () => {
  assert.deepEqual(parseUsComparisonBars({ bars: [bar('01', '600')] }), [bar('01', '600')])
  for (const payload of [null, {}, { bars: {} }, { bars: [] }, { bars: [null] }, { bars: [{ date: 'bad', close: 100 }] }]) {
    assert.throws(() => parseUsComparisonBars(payload))
  }
  for (const close of [null, '', true, false, undefined, 0, -1, Infinity, NaN]) {
    assert.throws(() => parseUsComparisonBars({ bars: [bar('01', close)] }), /invalid/)
  }
  assert.throws(() => parseUsComparisonBars({ error: 'Upstream failed' }), /Upstream failed/)
})

test('injected history requests pass cancellation and propagate upstream failures and rate limits', async () => {
  const controller = new AbortController()
  const bars = [bar('01', 100)]
  const result = await fetchUsComparisonBars('SPY', '1D', true, { signal: controller.signal, fetcher: async (url, options) => {
    assert.equal(url, '/api/us/bars/SPY?range=1D&extended=1')
    assert.equal(options.signal, controller.signal)
    return { ok: true, json: async () => ({ bars }) }
  } })
  assert.deepEqual(result, bars)
  await assert.rejects(fetchUsComparisonBars('QQQ', '1Y', false, { fetcher: async () => ({ ok: false, status: 502, json: async () => ({ error: 'Feed unavailable' }) }) }), /Feed unavailable/)
  const rateError = Object.assign(new Error('rate_limited'), { name: 'RateLimitedError' })
  await assert.rejects(fetchUsComparisonBars('QQQ', '1Y', false, { fetcher: async () => { throw rateError } }), error => error === rateError)
  controller.abort()
  await assert.rejects(fetchUsComparisonBars('QQQ', '1Y', false, { signal: controller.signal, fetcher: async (_url, { signal }) => { signal.throwIfAborted() } }), { name: 'AbortError' })
})
