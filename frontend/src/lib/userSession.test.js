import test from 'node:test'
import assert from 'node:assert/strict'
import { createPreferenceStore } from './userSession.js'
test('legacy preferences migrate only to GEK191 and remain private across account switches', () => {
  const data = new Map([['limit', '10']])
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
  let owner = null
  const prefs = createPreferenceStore(() => owner, storage)
  assert.equal(prefs.getItem('limit'), null)
  prefs.setItem('limit', '99')
  assert.equal(data.get('limit'), '10')
  owner = { appUserId: 'a', kiteUserId: 'GEK191' }
  assert.equal(prefs.getItem('limit'), '10')
  assert.equal(data.get('kite-user:a:limit'), '10')
  prefs.setItem('limit', '20')
  owner = { appUserId: 'b', kiteUserId: 'ABC123' }
  assert.equal(prefs.getItem('limit'), null)
  prefs.setItem('limit', '30')
  owner = { appUserId: 'a', kiteUserId: 'GEK191' }
  assert.equal(prefs.getItem('limit'), '20')
})
