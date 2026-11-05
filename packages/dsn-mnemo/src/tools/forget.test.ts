import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { insertDiary } from '../store/diary-store.js'
import { insertMessage, touchSession } from '../store/message-store.js'
import { writePortrait } from '../store/portrait-store.js'
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
    writePortrait(db, { kind: 'group', id: 'grp-1', part: 'long', content: '群画像' })
    writePortrait(db, { kind: 'member', id: 'grp-1:user-9', part: 'short', content: '群友' })
    writePortrait(db, { kind: 'user', id: 'user-1', part: 'long', content: '私聊画像' })
    writePortrait(db, { kind: 'member', id: 'other:user-1', part: 'short', content: '别处的群友' })

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
    assert.equal((db.prepare('select count(*) as n from portraits').get() as { n: number }).n, 2)
    const left = (
      db.prepare('select subject_kind, subject_id from portraits order by subject_id').all() as Array<{
        subject_kind: string
        subject_id: string
      }>
    ).map((row) => ({ subject_kind: row.subject_kind, subject_id: row.subject_id }))
    assert.deepEqual(left, [
      { subject_kind: 'member', subject_id: 'other:user-1' },
      { subject_kind: 'user', subject_id: 'user-1' },
    ])
  } finally {
    db.close()
  }
})
