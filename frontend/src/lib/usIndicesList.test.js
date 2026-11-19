import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { INDICES, US_RRG_KEYS, US_RRG_SECURITIES } from './usIndicesList.js'

const require = createRequire(import.meta.url)

// The sector list existed three times — this page, the /api/us/rrg default
// and the weekly RRG recorder — and adding Clean Energy meant remembering all
// three. A miss would plot a sector on the chart that is never recorded. Now
// the backend reads one list, and this holds the page to it.
test('the page plots exactly the RRG universe the backend records', () => {
  const { US_RRG_KEYS: backend } = require('../../../backend/rrg/universe.js')
  assert.deepEqual([...US_RRG_KEYS].sort(), [...backend].sort())
})

test('the chart request names the same keys, and every row is unique', () => {
  assert.deepEqual(US_RRG_SECURITIES.split(','), US_RRG_KEYS)
  const keys = INDICES.map(r => r.key)
  assert.equal(new Set(keys).size, keys.length)
})
