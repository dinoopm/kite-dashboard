import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildIndexComparison, percentageChange, parseKiteResponse } from './indexComparison.js'

const bar = (day, close) => ({ timestamp: `2026-09-${day}T00:00:00+05:30`, date: `Sep ${Number(day)}, 2026`, close, volume: 42 })
const indexBar = (day, close) => ({ date: `2026-09-${day}T00:00:00+05:30`, close })

test('compares different price levels on one common baseline without rounding', () => {
  const result = buildIndexComparison([bar('01', 100), bar('02', 110), bar('03', 90)], {
    nifty50: [indexBar('01', '20000'), indexBar('02', 21000), indexBar('03', 22000)],
    smallcap250: [indexBar('01', 15000), indexBar('02', 13500), indexBar('03', 16500)],
    midcap100: [indexBar('01', 30000), indexBar('02', 31500), indexBar('03', 33000)],
  })
  for (const key of ['stockReturn', ...result.indices]) assert.equal(result.data[0][key], 0)
  assert.ok(Math.abs(result.data[1].stockReturn - 10) < 1e-12)
  assert.ok(Math.abs(result.data[1].nifty50 - 5) < 1e-12)
  assert.ok(Math.abs(result.data[1].smallcap250 + 10) < 1e-12)
  assert.equal(result.data[1].volume, 42)
  assert.equal(result.shortened, false)
})

test('uses the first shared date and preserves missing sessions as gaps', () => {
  const result = buildIndexComparison([bar('01', 100), bar('02', 120), bar('03', 130), bar('04', 144)], {
    nifty50: [indexBar('02', 200), indexBar('04', 220)],
    midcap100: [indexBar('01', 1000), indexBar('02', 1100), indexBar('03', 1200)],
  })
  assert.equal(result.base, 120)
  assert.equal(result.shortened, true)
  assert.equal(result.data.length, 3)
  assert.equal(result.data[1].nifty50, null)
  assert.equal(result.data[2].midcap100, null)
  assert.deepEqual(result.endMissing, ['midcap100'])
})

test('no selection restores original prices; invalid or disjoint data cannot imply a return', () => {
  const stock = [bar('01', 100)]
  assert.deepEqual(buildIndexComparison(stock, {}).data, stock)
  const invalid = buildIndexComparison(stock, { nifty50: [null, {}, indexBar('01', null), indexBar('02', 50)] })
  assert.equal(invalid.base, null)
  assert.deepEqual(invalid.unavailable, ['nifty50'])
  assert.equal(buildIndexComparison([], { nifty50: [] }).base, null)
  const disjoint = buildIndexComparison([bar('01', 100), bar('02', 110)], {
    nifty50: [indexBar('01', 20)], midcap100: [indexBar('02', 30)],
  })
  assert.equal(disjoint.base, null)
})

test('intraday compares actual matching times, not only the calendar date', () => {
  const stock = ['09:15', '09:20'].map((time, i) => ({ timestamp: `2026-09-01T${time}:00+05:30`, date: time, close: 100 + i }))
  const result = buildIndexComparison(stock, { nifty50: [
    { date: '2026-09-01T03:50:00Z', close: 200 },
  ] }, true)
  assert.equal(result.startDate, '09:20')
  assert.equal(result.data.length, 1)
  assert.equal(result.data[0].nifty50, 0)
})

test('positive numeric strings normalize; absent and invalid prices stay unavailable', () => {
  assert.equal(percentageChange('110', '100'), (110 / 100 - 1) * 100)
  for (const value of [null, undefined, '', true, false, Infinity, NaN, 0, -1]) {
    assert.equal(percentageChange(value, 100), null)
    assert.equal(percentageChange(100, value), null)
  }
})

test('broker errors and malformed responses are failures rather than an empty comparison', () => {
  assert.deepEqual(parseKiteResponse({ content: [{ text: '[{"close":100}]' }] }), [{ close: 100 }])
  assert.throws(() => parseKiteResponse({ isError: true, content: [{ text: 'Rate limit exceeded' }] }), /Rate limit/)
  assert.throws(() => parseKiteResponse({ error: 'Unavailable' }), /Unavailable/)
  assert.throws(() => parseKiteResponse({ content: [] }), /incomplete/)
  assert.throws(() => parseKiteResponse({ content: [{ text: 'invalid' }] }))
})
