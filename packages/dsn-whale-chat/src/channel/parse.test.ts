import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEvent } from './parse.js'

function groupEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    self_id: 1000,
    user_id: 2000,
    group_id: 3000,
    message_id: 42,
    message: [{ type: 'text', data: { text: '大家好' } }],
    sender: { card: '小明' },
    time: 1_700_000_000,
    ...overrides,
  })
}

test('parses a group message and extracts the speaker', () => {
  const message = parseEvent(groupEvent())
  assert.ok(message)
  assert.equal(message.kind, 'group')
  assert.equal(message.userId, '2000')
  assert.equal(message.groupId, '3000')
  assert.equal(message.messageId, '42')
  assert.equal(message.text, '大家好')
  assert.equal(message.nickname, '小明')
  assert.equal(message.mentioned, false)
})

test('detects @ of the bot as mentioned', () => {
  const message = parseEvent(
    groupEvent({
      message: [
        { type: 'at', data: { qq: 1000 } },
        { type: 'text', data: { text: ' 在吗' } },
      ],
    }),
  )
  assert.equal(message?.mentioned, true)
  assert.equal(message?.text, ' 在吗')
})

test('does not treat @ of someone else as mentioned', () => {
  const message = parseEvent(groupEvent({ message: [{ type: 'at', data: { qq: 9999 } }, { type: 'text', data: { text: 'hi' } }] }))
  assert.equal(message?.mentioned, false)
})

test('parses a private message', () => {
  const message = parseEvent(
    JSON.stringify({ post_type: 'message', message_type: 'private', self_id: 1000, user_id: 2000, message_id: 7, message: [{ type: 'text', data: { text: '你好' } }] }),
  )
  assert.equal(message?.kind, 'dm')
  assert.equal(message?.groupId, null)
  assert.equal(message?.userId, '2000')
})

test('ignores non-message events and malformed frames', () => {
  assert.equal(parseEvent(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat' })), null)
  assert.equal(parseEvent('not json'), null)
  assert.equal(parseEvent(JSON.stringify({ post_type: 'message', message_type: 'group', user_id: 1, message_id: 2 })), null)
})
