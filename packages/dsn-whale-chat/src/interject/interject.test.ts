import assert from 'node:assert/strict'
import test from 'node:test'
import { createInterjectGate } from './interject.js'

test('is off by default', () => {
  const gate = createInterjectGate({ enabled: false, probability: 1, minMessagesBetween: 0, maxPerHour: 10 })
  assert.equal(gate(), false)
})

test('waits for minMessagesBetween before considering', () => {
  let random = 0
  const gate = createInterjectGate(
    { enabled: true, probability: 1, minMessagesBetween: 3, maxPerHour: 10 },
    { random: () => random },
  )
  assert.equal(gate(), false)
  assert.equal(gate(), false)
  assert.equal(gate(), true) // third message
})

test('respects the probability draw', () => {
  let draw = 0.9
  const gate = createInterjectGate(
    { enabled: true, probability: 0.05, minMessagesBetween: 0, maxPerHour: 10 },
    { random: () => draw },
  )
  assert.equal(gate(), false) // 0.9 >= 0.05
  draw = 0.01
  assert.equal(gate(), true) // 0.01 < 0.05
})

test('caps at maxPerHour and resets the counter', () => {
  let clock = 0
  let fires = 0
  const gate = createInterjectGate(
    { enabled: true, probability: 1, minMessagesBetween: 1, maxPerHour: 1 },
    { now: () => clock, random: () => 0 },
  )
  assert.equal(gate(), true)
  assert.equal(gate(), false) // cap
  clock += 3_600_001
  assert.equal(gate(), true) // window rolled
  fires += 1
  assert.equal(fires, 1)
})
