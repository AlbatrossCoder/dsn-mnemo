import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { getSubjectLedger, markDiaryWritten } from '../store/ledger-store.js'
import { insertMessage, touchSession } from '../store/message-store.js'
import { createPendingDiaryText, createPendingMindText } from './pending.js'

const NOW = new Date('2026-11-03T12:00:00Z')

function session(marker: string, id = 's1') {
  return { id, deriveMessages: () => [{ id: marker, role: 'user', source: { kind: 'user' } }] }
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
    const ledger = getSubjectLedger(db, { kind: 'user', id: 'local' })
    assert.equal(ledger?.diaryWrittenAt ?? null, null)
    assert.ok(ledger?.diaryPromptedAt)
    // Prompting is not settlement: the same stretch is not repeated, but it
    // stays open until diary_write.
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

test('a diary stretch stays open until diary_write, then only new content prompts again', () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 's1', 1)
    insertMessage(db, {
      sessionId: 's1',
      seq: 1,
      turn: 1,
      role: 'user',
      content: '昨天和主人一起去了海边，风很大但很安心，我们沿着沙滩走了很久很久。',
      raw: '{}',
    })
    db.prepare("update messages set created_at = '2026-11-03 10:00:00'").run()
    db.prepare("update sessions set last_turn_end_at = '2026-11-03 11:00:00' where id = 's1'").run()
    const pending = createPendingDiaryText(db, {
      idleMs: 20 * 60_000,
      maxTurns: 30,
      maxChars: 12_000,
      now: () => NOW,
    })
    assert.match(pending(session('m1')), /diary_write/)
    assert.equal(getSubjectLedger(db, { kind: 'user', id: 'local' })?.diaryWrittenAt ?? null, null)

    db.prepare("update subject_ledger set diary_prompted_at = '2026-11-03 11:00:00'").run()
    assert.equal(pending(session('m2')), '')

    insertMessage(db, {
      sessionId: 's1',
      seq: 2,
      turn: 2,
      role: 'user',
      content: '后来又聊了很久，想把这段也留下来，海风一直没停。',
      raw: '{}',
    })
    db.prepare("update messages set created_at = '2026-11-03 11:10:00' where seq = 2").run()
    // New content soon after the hint (idle since prompt not met) → remind, do not auto-file.
    const soon = createPendingDiaryText(db, {
      idleMs: 20 * 60_000,
      maxTurns: 30,
      maxChars: 12_000,
      now: () => new Date('2026-11-03T11:15:00Z'),
    })
    assert.match(soon(session('m3')), /diary_write/)
    assert.equal(getSubjectLedger(db, { kind: 'user', id: 'local' })?.diaryWrittenAt ?? null, null)

    markDiaryWritten(db, { kind: 'user', id: 'local' })
    db.prepare(
      "update subject_ledger set diary_written_at = '2026-11-03 11:50:00', diary_prompted_at = '2026-11-03 11:50:00'",
    ).run()
    assert.equal(pending(session('m4')), '')

    insertMessage(db, {
      sessionId: 's1',
      seq: 3,
      turn: 3,
      role: 'user',
      content: '晚饭后又说了一阵，这次是新的一段，值得再记一笔比较完整的日记。',
      raw: '{}',
    })
    db.prepare("update messages set created_at = '2026-11-03 11:55:00' where seq = 3").run()
    assert.match(pending(session('m5')), /diary_write/)
  } finally {
    db.close()
  }
})

test('pending diary counts every session of the subject and ignores other subjects', () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 'a1', 1, { kind: 'dm', audienceId: 'alice' })
    touchSession(db, 'a2', 1, { kind: 'dm', audienceId: 'alice' })
    touchSession(db, 'b1', 1, { kind: 'dm', audienceId: 'bob' })
    for (const [sessionId, seq] of [
      ['a1', 1],
      ['a1', 2],
      ['a2', 1],
      ['a2', 2],
    ] as const) {
      insertMessage(db, {
        sessionId,
        seq,
        turn: 1,
        role: 'user',
        content: `第${seq}句，记一下今天的事`,
        raw: '{}',
      })
    }
    insertMessage(db, {
      sessionId: 'b1',
      seq: 1,
      turn: 1,
      role: 'user',
      content: '鲍勃这边只有一句，不够单独成段。',
      raw: '{}',
    })
    db.prepare("update sessions set last_turn_end_at = '2026-11-03 11:59:00'").run()
    const pending = createPendingDiaryText(db, {
      idleMs: 20 * 60_000,
      maxTurns: 4,
      maxChars: 12_000,
      now: () => NOW,
    })
    assert.match(pending(session('alice', 'a2')), /diary_write/)
    assert.equal(pending(session('bob', 'b1')), '')
    assert.equal(getSubjectLedger(db, { kind: 'user', id: 'bob' }), undefined)
  } finally {
    db.close()
  }
})

test('a rich stretch asks for mind_update without settling the diary', () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 's1', 1, { kind: 'dm', audienceId: 'alice' })
    insertMessage(db, {
      sessionId: 's1',
      seq: 1,
      turn: 1,
      role: 'user',
      content: '今天聊了很久的近况，心情和还挂着的事都变了，值得更新一下心智。',
      raw: '{}',
    })
    db.prepare("update messages set created_at = '2026-11-03 10:00:00'").run()
    db.prepare("update sessions set last_turn_end_at = '2026-11-03 11:00:00' where id = 's1'").run()
    const options = { idleMs: 20 * 60_000, maxTurns: 30, maxChars: 12_000, now: () => NOW }
    const mind = createPendingMindText(db, options)
    assert.match(mind(session('m1')), /mind_update/)
    assert.equal(getSubjectLedger(db, { kind: 'user', id: 'alice' })?.diaryWrittenAt ?? null, null)
    assert.ok(getSubjectLedger(db, { kind: 'user', id: 'alice' })?.mindPromptedAt)
    assert.equal(getSubjectLedger(db, { kind: 'user', id: 'alice' })?.mindWrittenAt ?? null, null)
    assert.equal(mind(session('m2')), '')

    db.prepare("update subject_ledger set mind_prompted_at = '2026-11-03 11:00:00'").run()
    insertMessage(db, {
      sessionId: 's1',
      seq: 2,
      turn: 2,
      role: 'user',
      content: '又过了一阵，精力明显掉了下去，这段近况也该再写一笔心智更新。',
      raw: '{}',
    })
    db.prepare("update messages set created_at = '2026-11-03 11:40:00' where seq = 2").run()
    assert.match(mind(session('m3')), /mind_update/)
  } finally {
    db.close()
  }
})
