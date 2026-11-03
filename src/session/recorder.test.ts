import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { openDatabase } from '../db/database.js'
import { SessionRecorder } from './recorder.js'
import { countMessages, searchMessages } from '../store/message-store.js'

const session = { id: 's-recorder' }

function makeEvent(type: string, seq: number, data: unknown): SessionEvent {
  return { type, seq, time: 1_700_000_000_000, data } as unknown as SessionEvent
}

function userMessage(text: string): unknown {
  return {
    role: 'user',
    id: 'msg-user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function assistantMessage(text: string): unknown {
  return {
    turn: 1,
    step: 0,
    message: {
      role: 'assistant',
      id: 'msg-assistant',
      content: [
        { type: 'reasoning', text: '内部推理不应入库' },
        { type: 'text', text },
        { type: 'tool-call', id: 'call-1', name: 'recall', arguments: '{"query":"记忆"}' },
      ],
      source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
    },
    stream: [],
  }
}

function toolResult(text: string): unknown {
  return {
    turn: 1,
    step: 0,
    message: {
      role: 'tool',
      id: 'msg-tool',
      content: [{ type: 'text', text }],
      source: { kind: 'tool', callId: 'call-1' },
      toolCallId: 'call-1',
    },
  }
}

test('qq group messages record speaker, audience, and addressed', () => {
  const db = openDatabase(':memory:')
  try {
    const recorder = new SessionRecorder(db)
    recorder.handle(session, makeEvent('turn/start', 0, { turn: 1 }))
    recorder.handle(
      session,
      makeEvent('user/message', 1, {
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text: '@鲸鱼娘 在吗' }],
        source: { kind: 'qq', userId: '10001', groupId: '20002', mentioned: true },
      }),
    )
    const row = db.prepare('select speaker_id, addressed from messages').get() as {
      speaker_id: string
      addressed: number
    }
    assert.equal(row.speaker_id, '10001')
    assert.equal(row.addressed, 1)
    const sessionRow = db.prepare('select kind, audience_id from sessions where id = ?').get('s-recorder') as {
      kind: string
      audience_id: string
    }
    assert.equal(sessionRow.kind, 'group')
    assert.equal(sessionRow.audience_id, '20002')
  } finally {
    db.close()
  }
})

test('qq private messages become a dm subject', () => {
  const db = openDatabase(':memory:')
  try {
    const recorder = new SessionRecorder(db)
    recorder.handle(session, makeEvent('turn/start', 0, { turn: 1 }))
    recorder.handle(
      session,
      makeEvent('user/message', 1, {
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text: '在吗' }],
        source: { kind: 'qq', userId: '10001' },
      }),
    )
    const sessionRow = db.prepare('select kind, audience_id from sessions where id = ?').get('s-recorder') as {
      kind: string
      audience_id: string
    }
    assert.equal(sessionRow.kind, 'dm')
    assert.equal(sessionRow.audience_id, '10001')
  } finally {
    db.close()
  }
})

test('reasoning is stripped from the stored raw JSON by default', () => {
  const db = openDatabase(':memory:')
  try {
    const recorder = new SessionRecorder(db)
    recorder.handle(session, makeEvent('turn/start', 0, { turn: 1 }))
    recorder.handle(session, makeEvent('assistant/message', 1, assistantMessage('可见回答')))
    const row = db.prepare("select raw from messages where role = 'assistant'").get() as { raw: string }
    assert.doesNotMatch(row.raw, /内部推理/)
    assert.match(row.raw, /可见回答/)
  } finally {
    db.close()
  }
})

test('storeReasoning keeps reasoning blocks in raw JSON', () => {
  const db = openDatabase(':memory:')
  try {
    const recorder = new SessionRecorder(db, { storeReasoning: true })
    recorder.handle(session, makeEvent('turn/start', 0, { turn: 1 }))
    recorder.handle(session, makeEvent('assistant/message', 1, assistantMessage('可见回答')))
    const row = db.prepare("select raw from messages where role = 'assistant'").get() as { raw: string }
    assert.match(row.raw, /内部推理/)
  } finally {
    db.close()
  }
})

test('injected user-role context is not chat', () => {
  const db = openDatabase(':memory:')
  try {
    const recorder = new SessionRecorder(db)
    recorder.handle(session, makeEvent('turn/start', 0, { turn: 1 }))
    recorder.handle(
      session,
      makeEvent('user/message', 1, {
        id: 'ctx',
        role: 'user',
        content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }],
        source: { kind: 'time-context' },
      }),
    )
    recorder.handle(
      session,
      makeEvent('user/message', 2, {
        id: 'goal',
        role: 'user',
        content: [{ type: 'text', text: '<goal_round>…</goal_round>' }],
        source: { kind: 'goal' },
      }),
    )
    assert.equal(countMessages(db), 0)
  } finally {
    db.close()
  }
})

test('recorder stores user, assistant, and tool messages in L0', () => {
  const db = openDatabase(':memory:')
  try {
    const recorder = new SessionRecorder(db)
    recorder.handle(session, makeEvent('turn/start', 0, { turn: 1 }))
    recorder.handle(session, makeEvent('user/message', 1, userMessage('我们上次聊了记忆系统')))
    recorder.handle(session, makeEvent('assistant/message', 2, assistantMessage('是的，四层记忆')))
    recorder.handle(session, makeEvent('tool/result', 3, toolResult('检索到 2 条日记')))

    // L0 is chat only: the tool result is not conversation.
    assert.equal(countMessages(db), 2)
    const rows = db.prepare('select role, turn, content from messages order by seq').all() as Array<{
      role: string
      turn: number
      content: string
    }>
    assert.deepEqual(
      rows.map((row) => row.role),
      ['user', 'assistant'],
    )
    assert.deepEqual(
      rows.map((row) => row.turn),
      [1, 1],
    )
    assert.match(rows[1]?.content ?? '', /四层记忆/)
    assert.doesNotMatch(rows[1]?.content ?? '', /内部推理/)
    assert.doesNotMatch(rows[1]?.content ?? '', /\[call /)
  } finally {
    db.close()
  }
})

test('replaying the same events does not duplicate rows', () => {
  const db = openDatabase(':memory:')
  try {
    const recorder = new SessionRecorder(db)
    const events = [
      makeEvent('turn/start', 0, { turn: 1 }),
      makeEvent('user/message', 1, userMessage('同一句话')),
    ]
    for (const event of events) recorder.handle(session, event)
    for (const event of events) recorder.handle(session, event)
    assert.equal(countMessages(db), 1)
  } finally {
    db.close()
  }
})

test('system and developer messages are not memories', () => {
  const db = openDatabase(':memory:')
  try {
    const recorder = new SessionRecorder(db)
    recorder.handle(session, makeEvent('turn/start', 0, { turn: 1 }))
    recorder.handle(
      session,
      makeEvent('system/message', 1, { turn: 1, step: 0, message: userMessage('system prompt') }),
    )
    recorder.handle(session, makeEvent('developer/message', 2, { turn: 1, step: 0, message: userMessage('dev') }))
    assert.equal(countMessages(db), 0)
  } finally {
    db.close()
  }
})

test('malformed payloads never throw', () => {
  const db = openDatabase(':memory:')
  try {
    const recorder = new SessionRecorder(db)
    assert.doesNotThrow(() => recorder.handle(session, makeEvent('user/message', 1, null)))
    assert.doesNotThrow(() => recorder.handle(session, makeEvent('assistant/message', 2, { message: 'nope' })))
    assert.doesNotThrow(() => recorder.handle(session, makeEvent('unknown/type', 3, {})))
    assert.equal(countMessages(db), 0)
  } finally {
    db.close()
  }
})

test('recorded content is searchable through the L0 index', () => {
  const db = openDatabase(':memory:')
  try {
    const recorder = new SessionRecorder(db)
    recorder.handle(session, makeEvent('turn/start', 0, { turn: 1 }))
    recorder.handle(session, makeEvent('user/message', 1, userMessage('下周三去看海')))
    const hits = searchMessages(db, '看海')
    assert.equal(hits.length, 1)
  } finally {
    db.close()
  }
})
