import assert from 'node:assert/strict'
import test from 'node:test'
import { createInterjectGate } from './interject.js'

const base = { enabled: true, probability: 1, minMessagesBetween: 0, windowMinutes: 10, maxPerWindow: 3 }

test('is off by default', () => {
  const gate = createInterjectGate({ ...base, enabled: false })
  assert.equal(gate(), false)
})

test('waits for minMessagesBetween before considering', () => {
  const gate = createInterjectGate({ ...base, minMessagesBetween: 3 }, { random: () => 0 })
  assert.equal(gate(), false)
  assert.equal(gate(), false)
  assert.equal(gate(), true)
})

test('respects the probability draw', () => {
  let draw = 0.9
  const gate = createInterjectGate({ ...base, probability: 0.05 }, { random: () => draw })
  assert.equal(gate(), false)
  draw = 0.01
  assert.equal(gate(), true)
})

test('caps at maxPerWindow per 10 minutes and resets after the window', () => {
  let clock = 0
  const gate = createInterjectGate(
    { ...base, minMessagesBetween: 1, maxPerWindow: 3 },
    { now: () => clock, random: () => 0 },
  )
  assert.equal(gate(), true)
  assert.equal(gate(), true)
  assert.equal(gate(), true)
  assert.equal(gate(), false) // fourth within 10 minutes is capped
  clock += 10 * 60_000 + 1
  assert.equal(gate(), true) // window rolled
})
