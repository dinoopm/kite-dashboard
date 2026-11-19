import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { PRESET_SCREENS, RANGE_PRESET } from './screenerPresets.js'

// The registry is the backend's list of every claim the app may make.
const require = createRequire(import.meta.url)
const { signalMeta } = require('../../../backend/signals/registry.js')

// A preset is a buy cue. It carries the record of what it reproduces, or says
// in words that nothing has measured it — never neither.
test('every preset shows a track record or says it has none', () => {
  for (const p of PRESET_SCREENS) {
    assert.ok(p.signal || p.note, `${p.id} (${p.name}) has neither a signal badge nor a note`)
  }
  assert.ok(PRESET_SCREENS.includes(RANGE_PRESET))
})

test('every badge names a signal the registry knows', () => {
  for (const p of PRESET_SCREENS.filter(x => x.signal)) {
    assert.ok(signalMeta(p.signal), `${p.id}: "${p.signal}" is not in backend/signals/registry.js`)
  }
})

test('preset ids are unique', () => {
  const ids = PRESET_SCREENS.map(p => p.id)
  assert.equal(new Set(ids).size, ids.length)
})
