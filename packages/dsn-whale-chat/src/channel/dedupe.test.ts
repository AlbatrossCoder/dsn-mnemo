import assert from 'node:assert/strict'
import test from 'node:test'
import { createDedupe } from './dedupe.js'

test('dedupe returns true once per id', () => {
  const isNew = createDedupe()
  assert.equal(isNew('a'), true)
  assert.equal(isNew('a'), false)
  assert.equal(isNew('b'), true)
  assert.equal(isNew('a'), false)
})

test('dedupe evicts the oldest id past the cap', () => {
  const isNew = createDedupe(2)
  assert.equal(isNew('a'), true)
  assert.equal(isNew('b'), true)
  assert.equal(isNew('c'), true) // evicts 'a'
  assert.equal(isNew('a'), true) // treated as new again after eviction
  assert.equal(isNew('c'), false)
})
