import assert from 'node:assert/strict'
import test from 'node:test'
import { OneBotClient } from './client.js'
import type { Connect } from './transport.js'
import type { ChatMessage } from './types.js'

interface FakeSocket {
  url: string
  handlers: Parameters<Connect>[1]
  sent: string[]
  closed: boolean
}

function fakeConnect(): { connect: Connect; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  const connect: Connect = (url, handlers) => {
    const socket: FakeSocket = { url, handlers, sent: [], closed: false }
    sockets.push(socket)
    return {
      send: (data) => socket.sent.push(data),
      close: () => {
        socket.closed = true
      },
    }
  }
  return { connect, sockets }
}

function messageEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    self_id: 1000,
    user_id: 2000,
    group_id: 3000,
    message_id: 1,
    message: [{ type: 'text', data: { text: '你好' } }],
    ...overrides,
  })
}

test('connects with the token and dispatches deduped messages', () => {
  const { connect, sockets } = fakeConnect()
  const received: ChatMessage[] = []
  const client = new OneBotClient({
    url: 'ws://127.0.0.1:3001',
    token: 'abc',
    connect,
    onMessage: (message) => received.push(message),
  })

  client.start()
  assert.equal(sockets.length, 1)
  assert.match(sockets[0]?.url ?? '', /access_token=abc/)

  const socket = sockets[0]
  assert.ok(socket)
  assert.equal(client.connected, false)
  socket.handlers.onOpen()
  assert.equal(client.connected, true)

  socket.handlers.onMessage(messageEvent())
  socket.handlers.onMessage(messageEvent()) // same message_id
  assert.equal(received.length, 1)
  assert.equal(received[0]?.kind, 'group')
  assert.equal(received[0]?.text, '你好')

  client.stop()
})

test('sends a send_group_msg action', () => {
  const { connect, sockets } = fakeConnect()
  const client = new OneBotClient({ url: 'ws://x', connect, onMessage: () => {} })
  client.start()
  sockets[0]?.handlers.onOpen()

  client.sendGroup('3000', 'hi')

  const payload = JSON.parse(sockets[0]?.sent[0] ?? '{}') as { action: string; params: unknown }
  assert.equal(payload.action, 'send_group_msg')
  assert.deepEqual(payload.params, { group_id: 3000, message: [{ type: 'text', data: { text: 'hi' } }] })
  client.stop()
})

test('reconnects after the socket closes', async () => {
  const { connect, sockets } = fakeConnect()
  const client = new OneBotClient({ url: 'ws://x', connect, onMessage: () => {}, reconnectBaseMs: 5 })
  client.start()
  assert.equal(sockets.length, 1)

  sockets[0]?.handlers.onOpen()
  sockets[0]?.handlers.onClose()
  assert.equal(client.connected, false)

  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(sockets.length, 2)
  client.stop()
})
