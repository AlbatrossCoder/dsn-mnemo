import assert from 'node:assert/strict'
import test from 'node:test'
import { Config } from './index.js'

test('diaryIdleMinutes defaults to 20 minutes', () => {
  assert.equal(Config({}).diaryIdleMinutes, 20)
})

test('diaryIdleMinutes accepts the documented range', () => {
  assert.equal(Config({ diaryIdleMinutes: 5 }).diaryIdleMinutes, 5)
  assert.equal(Config({ diaryIdleMinutes: 1440 }).diaryIdleMinutes, 1440)
})

test('diaryIdleMinutes rejects values outside 5..1440', () => {
  assert.throws(() => Config({ diaryIdleMinutes: 4 }))
  assert.throws(() => Config({ diaryIdleMinutes: 1441 }))
})
