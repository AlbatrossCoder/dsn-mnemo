import assert from 'node:assert/strict'
import test from 'node:test'
import { splitReply, typingDelay } from './split.js'

const options = { groupMaxChars: 20, privateMaxChars: 30 }

test('short replies stay one message — no padding to the cap', () => {
  assert.deepEqual(splitReply('在的。', 'group', options), ['在的。'])
  assert.deepEqual(splitReply('嗯', 'dm', options), ['嗯'])
})

test('only a too-long reply is split, at 20 (group) / 30 (private)', () => {
  const text = '哥哥，今天天气挺好的，要不要一起出去走走？顺便吃点东西。对了，你昨天说的那家店还开着吗？'
  const group = splitReply(text, 'group', options)
  assert.ok(group.length >= 3)
  assert.ok(group.every((chunk) => chunk.length <= 20))
  const dm = splitReply(text, 'dm', options)
  assert.ok(dm.length >= 2)
  assert.ok(dm.length < group.length)
  assert.ok(dm.every((chunk) => chunk.length <= 30))
})

test('every newline is a message boundary the model chose', () => {
  assert.deepEqual(splitReply('第一句。\n第二句。', 'group', options), ['第一句。', '第二句。'])
  assert.deepEqual(splitReply('我\n不\n爱\n你！', 'dm', options), ['我', '不', '爱', '你！'])
})

test('【长】 sends the whole answer as one message, no char limit', () => {
  const body = '资料'.repeat(400)
  const chunks = splitReply(`【长】${body}`, 'group', options)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0], body)
})

test('a fenced code block is sent whole', () => {
  const text = '看这段：\n\n```\nconst a = 1\nconst b = 2\n```'
  const chunks = splitReply(text, 'dm', options)
  assert.equal(chunks.length, 1)
  assert.match(chunks[0] ?? '', /```/)
})

test('empty reply yields no messages', () => {
  assert.deepEqual(splitReply('   ', 'dm', options), [])
})

test('typingDelay estimates by length, clamps, and adds jitter', () => {
  const delayOptions = { msPerChar: 100, minMs: 400, maxMs: 4000, jitterMs: 1000 }
  // 3 chars → 300 → clamped to min 400; jitter 0
  assert.equal(typingDelay('你好呀', delayOptions, () => 0), 400)
  // 10 chars → 1000; jitter 0.5 → +500
  assert.equal(typingDelay('一二三四五六七八九十', delayOptions, () => 0.5), 1500)
  // very long → clamped to max 4000
  assert.equal(typingDelay('字'.repeat(100), delayOptions, () => 0), 4000)
})

test('successive delays vary with text length and the random draw', () => {
  const delayOptions = { msPerChar: 120, minMs: 400, maxMs: 4000, jitterMs: 500 }
  const first = typingDelay('嗯', delayOptions, () => 0)
  const second = typingDelay('嗯', delayOptions, () => 0.9)
  assert.ok(second > first)
})
