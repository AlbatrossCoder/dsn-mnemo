import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatMessage } from '../channel/types.js'
import { asAddressed, conversationKey, toFollowMessage, toUserMessage } from './message.js'

function dm(): ChatMessage {
  return { kind: 'dm', userId: '2000', groupId: null, messageId: '1', text: '你好', mentioned: true, nickname: null, at: 0 }
}

function group(): ChatMessage {
  return {
    kind: 'group',
    userId: '2000',
    groupId: '3000',
    messageId: '2',
    text: '大家好',
    mentioned: false,
    nickname: '小明',
    at: 0,
  }
}

test('conversationKey distinguishes dm from group', () => {
  assert.equal(conversationKey(dm()), 'user:2000')
  assert.equal(conversationKey(group()), 'group:3000')
})

test('toUserMessage carries QQ identity and text', () => {
  const message = toUserMessage(group())
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'qq')
  assert.equal(message.source.userId, '2000')
  assert.equal(message.source.groupId, '3000')
  assert.equal(message.source.mentioned, false)
  assert.deepEqual(message.content, [{ type: 'text', text: '大家好' }])
  assert.equal(typeof message.id, 'string')
})

test('asAddressed marks a group message mentioned without touching a dm', () => {
  const addressed = asAddressed(group())
  assert.equal(addressed.mentioned, true)
  assert.equal(addressed.text, '大家好')
  assert.equal(asAddressed({ ...group(), mentioned: true }).mentioned, true)
  assert.equal(asAddressed(dm()).mentioned, true)
  const stored = toUserMessage(addressed)
  assert.equal(stored.source.mentioned, true)
})

test('toFollowMessage is a nudge and not a stored chat line', () => {
  const message = toFollowMessage(group(), { transcript: '[小明/2000] 然后呢', relation: 'same', level: 0 })
  assert.equal(message.source.kind, 'qq-proactive')
  assert.equal(message.source.groupId, '3000')
  const text = message.content[0]?.text ?? ''
  assert.match(text, /然后呢/)
  assert.match(text, /SILENT/)
  assert.match(text, /刚接过话/)
  assert.match(text, /刚才那件事/)
})

test('a faded follow-up says the thread has cooled', () => {
  const message = toFollowMessage(group(), { transcript: '[小明/2000] 火锅几个人', relation: 'same', level: 2 })
  const text = message.content[0]?.text ?? ''
  assert.match(text, /这条线淡了/)
  assert.match(text, /刚才那件事/)
})

test('a new subject stays inside the fade', () => {
  const message = toFollowMessage(group(), { transcript: '[小明/2000] 今天天气真好', relation: 'new', level: 1 })
  const text = message.content[0]?.text ?? ''
  assert.match(text, /话头在淡/)
  assert.match(text, /淡出不重置/)
})
