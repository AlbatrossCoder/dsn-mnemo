import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { insertDiary } from '../store/diary-store.js'
import { insertMessage, touchSession } from '../store/message-store.js'
import { upsertAnchor } from '../store/anchor-store.js'
import { createForgetTool } from './forget.js'

test('forget erases one subject and leaves the others alone', async () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 'g1', 1, { kind: 'group', audienceId: 'grp-1' })
    insertMessage(db, { sessionId: 'g1', seq: 1, turn: 1, role: 'user', content: '群消息', raw: '{}' })
    touchSession(db, 'd1', 1, { kind: 'dm', audienceId: 'user-1' })
    insertMessage(db, { sessionId: 'd1', seq: 1, turn: 1, role: 'user', content: '私聊消息', raw: '{}' })

    insertDiary(db, { subjectKind: 'group', subjectId: 'grp-1', content: '群日记' })
    insertDiary(db, { subjectKind: 'user', subjectId: 'user-1', content: '私聊日记' })
    upsertAnchor(db, { eventName: '群纪念日', targetDate: '2026-11-05', subject: { kind: 'group', id: 'grp-1' } })
    upsertAnchor(db, { eventName: '生日', targetDate: '2026-11-05', subject: { kind: 'user', id: 'user-1' } })

    const tool = createForgetTool(db)
    const result = (await tool.execute(
      { subject_kind: 'group', subject_id: 'grp-1' },
      {} as never,
    )) as { messages: number; diaries: number; anchors: number }

    assert.equal(result.messages, 1)
    assert.equal(result.diaries, 1)
    assert.equal(result.anchors, 1)
    assert.equal((db.prepare('select count(*) as n from messages').get() as { n: number }).n, 1)
    assert.equal((db.prepare('select count(*) as n from diaries').get() as { n: number }).n, 1)
    assert.equal((db.prepare('select count(*) as n from anchors').get() as { n: number }).n, 1)
    assert.equal((db.prepare('select count(*) as n from sessions').get() as { n: number }).n, 1)
  } finally {
    db.close()
  }
})
