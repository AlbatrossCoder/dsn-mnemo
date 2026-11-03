import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { countDiaries, searchDiaries } from '../store/diary-store.js'
import { touchSession } from '../store/message-store.js'
import { createDiaryUpdateTool, createDiaryWriteTool } from './diary-write.js'

const exec = {} as never

test('diary_write stores content with clamped scores and tags', async () => {
  const db = openDatabase(':memory:')
  try {
    const tool = createDiaryWriteTool(db)
    const result = (await tool.execute(
      { content: '今天和主人一起看了海，风很大，但很安心。', importance: 2, emotion: -1, tags: '日常, 约定' },
      exec,
    )) as { id: number }
    const row = db.prepare('select importance, emotion, type_tags from diaries where id = ?').get(result.id) as {
      importance: number
      emotion: number
      type_tags: string
    }
    assert.equal(row.importance, 1)
    assert.equal(row.emotion, 0)
    assert.equal(row.type_tags, '日常,约定')
    assert.equal(countDiaries(db), 1)
  } finally {
    db.close()
  }
})

test('diary_write attaches the current session subject', async () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 's-1', 1, { kind: 'dm', audienceId: 'u-42' })
    const tool = createDiaryWriteTool(db)
    const exec = { agent: { session: { id: 's-1' } } } as never
    const result = (await tool.execute({ content: '今天和主人一起看了海' }, exec)) as { id: number }
    const row = db.prepare('select session_id, subject_kind, subject_id from diaries where id = ?').get(result.id) as {
      session_id: string
      subject_kind: string
      subject_id: string
    }
    assert.equal(row.session_id, 's-1')
    assert.equal(row.subject_kind, 'user')
    assert.equal(row.subject_id, 'u-42')
  } finally {
    db.close()
  }
})

test('diary_update backs up the old text before rewriting', async () => {
  const db = openDatabase(':memory:')
  try {
    const write = createDiaryWriteTool(db)
    const update = createDiaryUpdateTool(db)
    const created = (await write.execute({ content: '主人说下周去海边', importance: 0.6 }, exec)) as { id: number }

    const result = (await update.execute(
      { id: created.id, content: '主人说下周去山里，原计划取消了。', reason: '用户纠正了地点' },
      exec,
    )) as { id: number; revision: number }

    const diary = db.prepare('select content, content_seg from diaries where id = ?').get(result.id) as {
      content: string
      content_seg: string
    }
    assert.match(diary.content, /山里/)
    assert.match(diary.content_seg, /山里/)
    assert.doesNotMatch(diary.content_seg, /海边/)

    const revision = db
      .prepare('select content, reason from diary_revisions where diary_id = ?')
      .get(result.id) as { content: string; reason: string }
    assert.match(revision.content, /海边/)
    assert.match(revision.reason, /纠正/)

    // The rewritten text is what the index now serves.
    assert.equal(searchDiaries(db, '山里').length, 1)
  } finally {
    db.close()
  }
})

test('diary_update requires a meaningful reason and an existing row', async () => {
  const db = openDatabase(':memory:')
  try {
    const write = createDiaryWriteTool(db)
    const update = createDiaryUpdateTool(db)
    const created = (await write.execute({ content: '一条会被纠正的日记内容' }, exec)) as { id: number }

    await assert.rejects(update.execute({ id: created.id, content: '新的内容', reason: '改' }, exec), /reason/)
    await assert.rejects(
      update.execute({ id: 9999, content: '新的内容', reason: '用户纠正了事实' }, exec),
      /not found/,
    )
  } finally {
    db.close()
  }
})
