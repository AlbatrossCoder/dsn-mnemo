import assert from 'node:assert/strict'
import test from 'node:test'
import { matchesAny } from './text.js'

test('matchesAny finds configured names', () => {
  assert.equal(matchesAny('小鲸鱼在吗', ['小鲸鱼']), true)
  assert.equal(matchesAny('在吗', ['小鲸鱼']), false)
  assert.equal(matchesAny('喂，你好', ['喂']), true)
})

test('matchesAny is case-insensitive and ignores blank needles', () => {
  assert.equal(matchesAny('Hello Whale', ['whale']), true)
  assert.equal(matchesAny('abc', ['', '  ']), false)
})
