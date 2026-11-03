import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import {
  countMessages,
  insertMessage,
  listRecentMessages,
  searchMessages,
  touchSession,
} from './message-store.js'

test('messages dedupe by (session_id, seq)', () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 's1', 1)
    const input = { sessionId: 's1', seq: 3, turn: 1, role: 'user' as const, content: '今天聊了记忆', raw: '{}' }
    assert.equal(insertMessage(db, input), true)
    assert.equal(insertMessage(db, input), false)
    assert.equal(countMessages(db), 1)
  } finally {
    db.close()
  }
})

test('searchMessages finds Chinese content and reports role', () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 's1', 1)
    insertMessage(db, {
      sessionId: 's1',
      seq: 1,
      turn: 1,
      role: 'user',
      content: '我们上次聊了记忆系统的设计',
      raw: '{}',
    })
    insertMessage(db, {
      sessionId: 's1',
      seq: 2,
      turn: 1,
      role: 'assistant',
      content: '是的，设计里包含四层记忆',
      raw: '{}',
    })

    const hits = searchMessages(db, '记忆系统')
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.role, 'user')
    assert.equal(typeof hits[0]?.rank, 'number')
    assert.deepEqual(searchMessages(db, '  '), [])
  } finally {
    db.close()
  }
})

test('character fallback finds rephrased Chinese in logs', () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 's1', 1)
    insertMessage(db, {
      sessionId: 's1',
      seq: 1,
      turn: 1,
      role: 'user',
      content: '下周三去看了海，风很大',
      raw: '{}',
    })
    const hits = searchMessages(db, '看海')
    assert.equal(hits.length, 1)
  } finally {
    db.close()
  }
})

test('listRecentMessages returns the tail in chronological order', () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 's1', 3)
    for (let seq = 1; seq <= 5; seq += 1) {
      insertMessage(db, {
        sessionId: 's1',
        seq,
        turn: seq,
        role: 'user',
        content: `第 ${seq} 句`,
        raw: '{}',
      })
    }
    const recent = listRecentMessages(db, 's1', 2)
    assert.deepEqual(
      recent.map((hit) => hit.seq),
      [4, 5],
    )
  } finally {
    db.close()
  }
})
