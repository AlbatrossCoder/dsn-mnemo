import assert from 'node:assert/strict'
import test from 'node:test'
import { splitReply } from './split.js'

const options = { groupMaxChars: 20, privateMaxChars: 30, longFormMaxChars: 800 }

test('short replies stay one message', () => {
  assert.deepEqual(splitReply('在的。', 'group', options), ['在的。'])
  assert.deepEqual(splitReply('哥哥，这只是个测试数字嘛？', 'dm', options), ['哥哥，这只是个测试数字嘛？'])
})

test('group replies split at 20 chars, private at 30', () => {
  const text = '哥哥，今天天气挺好的，要不要一起出去走走？顺便吃点东西。对了，你昨天说的那家店还开着吗？'
  const group = splitReply(text, 'group', options)
  assert.ok(group.length >= 3)
  assert.ok(group.every((chunk) => chunk.length <= 20))
  const dm = splitReply(text, 'dm', options)
  assert.ok(dm.length >= 2)
  assert.ok(dm.length < group.length)
  assert.ok(dm.every((chunk) => chunk.length <= 30))
})

test('blank lines are hard boundaries', () => {
  const chunks = splitReply('第一句。\n\n第二句。', 'group', options)
  assert.deepEqual(chunks, ['第一句。', '第二句。'])
})

test('【长】 marker uses the long-form limit', () => {
  const text = `【长】${'资料'.repeat(40)}`
  const chunks = splitReply(text, 'group', options)
  assert.equal(chunks.length, 1)
  assert.doesNotMatch(chunks[0] ?? '', /【长】/)
})

test('a code block is kept atomic', () => {
  const text = '看这段：\n\n```\nconst a = 1\nconst b = 2\n```'
  const chunks = splitReply(text, 'dm', options)
  assert.equal(chunks.length, 2)
  assert.match(chunks[1] ?? '', /```/)
})

test('empty reply yields no messages', () => {
  assert.deepEqual(splitReply('   ', 'dm', options), [])
})
