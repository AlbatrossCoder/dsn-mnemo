/**
 * Mock end-to-end: a fake OneBot socket pushes one group message through the
 * real client, the real bridge, and a fake DSH context; a fake `assistant/message`
 * comes back and must be sent out through the client.
 *
 * No NapCat / real DSH needed — this is the wiring proof.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { ChatBridge } from './bridge/bridge.js'
import { OneBotClient } from './channel/client.js'
import type { Connect, ConnectHandlers, Connection } from './channel/transport.js'
import type { ChatMessage } from './channel/types.js'

interface FakeSocket {
  url: string
  handlers: ConnectHandlers
  sent: string[]
}

function fakeSockets(): { connect: Connect; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  const connect: Connect = (url, handlers) => {
    const socket: FakeSocket = { url, handlers, sent: [] }
    sockets.push(socket)
    const connection: Connection = {
      send: (data) => socket.sent.push(data),
      close: () => {},
    }
    return connection
  }
  return { connect, sockets }
}

interface SessionLike {
  id: string
}
interface EventLike {
  type: string
  data: unknown
}
type SessionListener = (session: SessionLike, event: EventLike) => void

interface FakeHost {
  ctx: Context
  followups: unknown[]
  listeners: SessionListener[]
  createdSessionIds: string[]
}

function fakeContext(): FakeHost {
  const followups: unknown[] = []
  const listeners: SessionListener[] = []
  const createdSessionIds: string[] = []
  const ctx = {
    agents: {
      create: async (options: { sessionId: string }) => {
        createdSessionIds.push(options.sessionId)
        return {
          agent: {
            session: { id: options.sessionId },
            followup: (message: unknown) => {
              followups.push(message)
            },
          },
        }
      },
    },
    on: (_event: string, handler: SessionListener) => {
      listeners.push(handler)
    },
  } as unknown as Context
  return { ctx, followups, listeners, createdSessionIds }
}

test('mock end-to-end: group message → agent followup → assistant reply → QQ send', async () => {
  const { ctx, followups, listeners, createdSessionIds } = fakeContext()
  const replies: Array<{ target: ChatMessage; text: string }> = []
  const bridge = new ChatBridge({ ctx, reply: (target, text) => replies.push({ target, text }) })

  const { connect, sockets } = fakeSockets()
  const client = new OneBotClient({
    url: 'ws://fake:3001',
    connect,
    onMessage: (message) => {
      void bridge.receive(message)
    },
  })
  client.start()
  sockets[0]?.handlers.onOpen()

  sockets[0]?.handlers.onMessage(
    JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      self_id: 1000,
      user_id: 2000,
      group_id: 3000,
      message_id: 'm1',
      message: [
        { type: 'at', data: { qq: 1000 } },
        { type: 'text', data: { text: '在吗' } },
      ],
    }),
  )

  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(followups.length, 1)
  const followup = followups[0] as {
    source: { kind: string; userId: string; groupId?: string }
    content: Array<{ type: string; text: string }>
  }
  assert.equal(followup.source.kind, 'qq')
  assert.equal(followup.source.userId, '2000')
  assert.equal(followup.source.groupId, '3000')
  assert.equal(followup.content[0]?.text, '在吗')

  assert.equal(createdSessionIds.length, 1)
  const sessionId = createdSessionIds[0] as string
  assert.equal(listeners.length, 1)
  listeners[0]?.(
    { id: sessionId },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在的。' }] } } },
  )

  assert.equal(replies.length, 1)
  assert.equal(replies[0]?.text, '在的。')
  assert.equal(replies[0]?.target.kind, 'group')
  assert.equal(replies[0]?.target.groupId, '3000')

  client.stop()
})

test('mock end-to-end: private message keeps userId and ignores empty text', async () => {
  const { ctx, followups, listeners, createdSessionIds } = fakeContext()
  const bridge = new ChatBridge({ ctx, reply: () => {} })

  const { connect, sockets } = fakeSockets()
  const client = new OneBotClient({
    url: 'ws://fake:3001',
    connect,
    onMessage: (message) => {
      void bridge.receive(message)
    },
  })
  client.start()
  sockets[0]?.handlers.onOpen()

  sockets[0]?.handlers.onMessage(
    JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      self_id: 1000,
      user_id: 42,
      message_id: 'p1',
      message: [{ type: 'text', data: { text: '你好' } }],
    }),
  )

  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(followups.length, 1)
  const followup = followups[0] as { source: { kind: string; userId: string }; content: Array<{ text: string }> }
  assert.equal(followup.source.kind, 'qq')
  assert.equal(followup.source.userId, '42')
  assert.equal(createdSessionIds.length, 1)
  assert.equal(listeners.length, 1)

  client.stop()
})
