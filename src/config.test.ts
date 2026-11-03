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

test('length triggers have usable defaults and bounds', () => {
  const parsed = Config({})
  assert.equal(parsed.diaryMaxTurns, 30)
  assert.equal(parsed.diaryMaxChars, 12_000)
  assert.equal(Config({ diaryMaxTurns: 10 }).diaryMaxTurns, 10)
  assert.equal(Config({ diaryMaxChars: 2000 }).diaryMaxChars, 2000)
  assert.throws(() => Config({ diaryMaxTurns: 9 }))
  assert.throws(() => Config({ diaryMaxChars: 1999 }))
})
