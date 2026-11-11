import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { moveEndpoint, nearestEndpoint } from './measurementEdit.js'

const done = { active: false, start: { price: 456.68, date: '2026-11-02' }, end: { price: 621.84, date: '2026-09-21' }, preview: null }

describe('moveEndpoint', () => {
  // A finished measurement used to be frozen: adjusting either end meant
  // clearing it and clicking twice again. Now either end can be dragged.
  test('moves the end point of a finished measurement', () => {
    const next = moveEndpoint(done, 'end', { price: 600, date: '2026-09-25' })
    assert.equal(next.end.price, 600)
    assert.equal(next.start, done.start, 'and leaves the other end where it was')
  })

  test('moves the start point', () => {
    assert.equal(moveEndpoint(done, 'start', { price: 470, date: '2026-10-30' }).start.price, 470)
  })

  // The percentage divides by the start price.
  test('refuses to move the start to a price of zero or below', () => {
    assert.equal(moveEndpoint(done, 'start', { price: 0, date: '2026-10-30' }), done)
    assert.equal(moveEndpoint(done, 'start', { price: -5, date: '2026-10-30' }), done)
  })

  test('ignores a missing or non-numeric point', () => {
    assert.equal(moveEndpoint(done, 'end', null), done)
    assert.equal(moveEndpoint(done, 'end', { price: NaN }), done)
  })

  // Only a FINISHED measurement is editable: while the second click is still
  // being chosen, the preview already follows the cursor.
  test('does nothing while a measurement is still being placed', () => {
    const placing = { ...done, active: true, end: null }
    assert.equal(moveEndpoint(placing, 'start', { price: 470 }), placing)
  })

  test('ignores an unknown handle', () => {
    assert.equal(moveEndpoint(done, 'middle', { price: 470 }), done)
  })
})

describe('nearestEndpoint', () => {
  const from = { x: 100, y: 200 }, to = { x: 400, y: 80 }

  test('picks the end under the pointer within the grab radius', () => {
    assert.equal(nearestEndpoint(from, to, 104, 197), 'start')
    assert.equal(nearestEndpoint(from, to, 393, 86), 'end')
  })

  test('picks nothing away from both ends, so the chart still pans there', () => {
    assert.equal(nearestEndpoint(from, to, 250, 140), null)
  })

  test('picks the closer end when both are within reach', () => {
    assert.equal(nearestEndpoint({ x: 100, y: 100 }, { x: 108, y: 100 }, 106, 100), 'end')
  })

  test('copes with a missing end', () => {
    assert.equal(nearestEndpoint(from, null, 101, 201), 'start')
    assert.equal(nearestEndpoint(null, null, 101, 201), null)
  })
})
