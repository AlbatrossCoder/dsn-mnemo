import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatMessage } from '../channel/types.js'
import { conversationKey, toUserMessage } from './message.js'

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
