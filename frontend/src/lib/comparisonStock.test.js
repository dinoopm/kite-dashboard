import { test } from 'node:test'
import assert from 'node:assert/strict'
import { comparisonStockDefinition, comparisonSearchUrl, parseComparisonStocks } from './comparisonStock.js'
import { buildIndexComparison } from './indexComparison.js'

test('stock search uses the current market and encodes symbol/company names', () => {
  assert.equal(comparisonSearchUrl('IN', ' TATA MOTOR '), '/api/search-instruments?q=TATA%20MOTOR')
  assert.equal(comparisonSearchUrl('US', 'BRK/B'), '/api/us/search?q=BRK%2FB')
})

test('Indian stocks retain the chosen exchange and broker token; US stocks use their symbol', () => {
  const india = comparisonStockDefinition({ symbol: 'TCS', exchange: 'BSE', token: 123 }, 'IN')
  assert.equal(india.token, '123')
  assert.equal(india.key, 'BSE:TCS')
  assert.equal(india.label, 'TCS (BSE)')
  const us = comparisonStockDefinition({ symbol: 'MSFT', exchange: 'Nasdaq' }, 'US')
  assert.equal(us.symbol, 'MSFT')
  assert.equal(us.token, null)
  for (const token of [undefined, '', 0, -1, 'invalid']) assert.equal(comparisonStockDefinition({ symbol: 'TCS', token }, 'IN'), null)
  assert.equal(comparisonStockDefinition(null, 'US'), null)
})

test('search rejects invalid responses and removes the current instrument and duplicate results', () => {
  const rows = [{ symbol: 'HDFCBANK', token: '341249' }, { symbol: 'TCS', token: '123', exchange: 'NSE' }]
  assert.deepEqual(parseComparisonStocks({ results: [...rows, rows[1], {}, null] }, 'IN', '341249'), [rows[1]])
  const us = [{ symbol: 'AMZN' }, { symbol: 'MSFT' }]
  assert.deepEqual(parseComparisonStocks({ results: [...us, us[1]] }, 'US', 'AMZN'), [us[1]])
  assert.deepEqual(parseComparisonStocks({ results: [] }, 'US', 'AMZN'), [])
  assert.throws(() => parseComparisonStocks({ error: 'Search failed' }, 'IN'), /Search failed/)
  assert.throws(() => parseComparisonStocks({}, 'US'), /invalid response/)
})

test('a selected stock works alongside benchmarks, can be replaced, and leaves gaps unfilled', () => {
  const bars = values => values.map((close, index) => ({ date: `2026-09-0${index + 1}T04:00:00Z`, close }))
  const stock = bars([100, 110, 120])
  const one = buildIndexComparison(stock, { sp500: bars([600, 630, 660]), comparisonStock: bars([200, 220, 240]) })
  assert.equal(one.data[0].comparisonStock, 0)
  assert.ok(Math.abs(one.data[2].comparisonStock - 20) < 1e-10)
  const replacement = buildIndexComparison(stock, { sp500: bars([600, 630, 660]), comparisonStock: bars([400, 360, 320]) })
  assert.ok(Math.abs(replacement.data[2].comparisonStock + 20) < 1e-10)
  const missing = buildIndexComparison(stock, { comparisonStock: [bars([200])[0], bars([200, 220, 240])[2]] })
  assert.equal(missing.data[1].comparisonStock, null)
  assert.deepEqual(buildIndexComparison(stock, {}).data, stock)
})
