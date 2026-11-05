import assert from 'node:assert/strict'
import test from 'node:test'
import { splitReply, typingDelay } from './split.js'

test('a newline is a message boundary', () => {
  assert.deepEqual(splitReply('在的。'), ['在的。'])
  assert.deepEqual(splitReply('第一句。\n第二句。'), ['第一句。', '第二句。'])
})

test('a fenced block stays one message', () => {
  const text = '看这段：\n```\nconst a = 1\nconst b = 2\n```\n好了'
  const chunks = splitReply(text)
  assert.equal(chunks.length, 3)
  assert.match(chunks[1] ?? '', /const a = 1\nconst b = 2/)
})

test('a line over the platform limit is cut on a sentence boundary', () => {
  const text = `${'甲'.repeat(10)}。${'乙'.repeat(10)}。`
  const chunks = splitReply(text, { platformMaxChars: 12 })
  assert.ok(chunks.length >= 2)
  assert.ok(chunks.every((chunk) => chunk.length <= 12))
})

test('a long reply is not truncated', () => {
  const chunks = splitReply('一二三\n四五六\n七八九')
  assert.deepEqual(chunks, ['一二三', '四五六', '七八九'])
})

test('empty reply yields no messages', () => {
  assert.deepEqual(splitReply('   '), [])
})

test('typingDelay stays inside the short and long bands', () => {
  assert.equal(typingDelay('嗯', () => 0), 1500)
  assert.ok(typingDelay('嗯', () => 0.9999) >= 2490)
  assert.ok(typingDelay('嗯', () => 0.9999) <= 2500)
  assert.equal(typingDelay('字'.repeat(30), () => 0), 2500)
  assert.ok(typingDelay('字'.repeat(30), () => 0.9999) <= 4000)
})
