import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { insertMessage, touchSession } from '../store/message-store.js'
import { createPendingDiaryText } from './pending.js'

const NOW = new Date('2026-11-03T12:00:00Z')

function session(marker: string) {
  return { id: 's1', deriveMessages: () => [{ id: marker, role: 'user', source: { kind: 'user' } }] }
}

test('no hint when the last turn just ended and content is short', () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 's1', 1)
    insertMessage(db, {
      sessionId: 's1',
      seq: 1,
      turn: 1,
      role: 'user',
      content: '今天聊了记忆系统的设计，内容还挺多的，聊到很晚。',
      raw: '{}',
    })
    db.prepare("update sessions set last_turn_end_at = '2026-11-03 11:59:00' where id = 's1'").run()
    const pending = createPendingDiaryText(db, {
      idleMs: 20 * 60_000,
      maxTurns: 30,
      maxChars: 12_000,
      now: () => NOW,
    })
    assert.equal(pending(session('m1')), '')
  } finally {
    db.close()
  }
})

test('a quiet gap plus pending content yields a hint and advances the mark', () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 's1', 1)
    insertMessage(db, { sessionId: 's1', seq: 1, turn: 1, role: 'user', content: '昨天和主人一起去了海边，风很大但很安心，我们沿着沙滩走了很久很久。', raw: '{}' })
    insertMessage(db, { sessionId: 's1', seq: 2, turn: 1, role: 'assistant', content: '听起来不错。', raw: '{}' })
    db.prepare("update sessions set last_turn_end_at = '2026-11-03 11:00:00' where id = 's1'").run()
    const pending = createPendingDiaryText(db, {
      idleMs: 20 * 60_000,
      maxTurns: 30,
      maxChars: 12_000,
      now: () => NOW,
    })
    const first = pending(session('m1'))
    assert.match(first, /diary_write/)
    // Memoised: the same turn returns the same text.
    assert.equal(pending(session('m1')), first)
    // The judged mark advanced, so a *new* turn no longer re-reminds for the
    // same already-seen stretch (nothing new accumulated).
    assert.equal(pending(session('m2')), '')
  } finally {
    db.close()
  }
})

test('length threshold alone prompts without a quiet gap', () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 's1', 1)
    for (let index = 1; index <= 11; index += 1) {
      insertMessage(db, {
        sessionId: 's1',
        seq: index,
        turn: 1,
        role: 'user',
        content: `第 ${index} 句话，内容稍微长一点`,
        raw: '{}',
      })
    }
    db.prepare("update sessions set last_turn_end_at = '2026-11-03 11:59:00' where id = 's1'").run()
    const pending = createPendingDiaryText(db, {
      idleMs: 20 * 60_000,
      maxTurns: 10,
      maxChars: 12_000,
      now: () => NOW,
    })
    assert.match(pending(session('m1')), /diary_write/)
  } finally {
    db.close()
  }
})

test('pure group chatter never prompts a diary hint', () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 'g1', 1, { kind: 'group', audienceId: 'grp-1' })
    insertMessage(db, {
      sessionId: 'g1',
      seq: 1,
      turn: 1,
      role: 'user',
      content: '大家今天聊了天气，内容还挺多的',
      addressed: false,
      raw: '{}',
    })
    db.prepare("update sessions set last_turn_end_at = '2026-11-03 11:00:00' where id = 'g1'").run()
    const pending = createPendingDiaryText(db, {
      idleMs: 20 * 60_000,
      maxTurns: 30,
      maxChars: 12_000,
      now: () => NOW,
    })
    const g = { id: 'g1', deriveMessages: () => [{ id: 'm1', role: 'user', source: { kind: 'qq' } }] }
    assert.equal(pending(g), '')
  } finally {
    db.close()
  }
})

test('an addressed group turn prompts a diary hint after a gap', () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 'g1', 1, { kind: 'group', audienceId: 'grp-1' })
    insertMessage(db, {
      sessionId: 'g1',
      seq: 1,
      turn: 1,
      role: 'user',
      content: '今天群活动，我 @ 了鲸鱼娘让她把今天的聚会记下来',
      addressed: true,
      raw: '{}',
    })
    insertMessage(db, { sessionId: 'g1', seq: 2, turn: 1, role: 'assistant', content: '好的，我记下了今天的聚会', raw: '{}' })
    db.prepare("update sessions set last_turn_end_at = '2026-11-03 11:00:00' where id = 'g1'").run()
    const pending = createPendingDiaryText(db, {
      idleMs: 20 * 60_000,
      maxTurns: 30,
      maxChars: 12_000,
      now: () => NOW,
    })
    const g = { id: 'g1', deriveMessages: () => [{ id: 'm1', role: 'user', source: { kind: 'qq' } }] }
    assert.match(pending(g), /diary_write/)
  } finally {
    db.close()
  }
})
