import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase, rebuildIndexes } from '../db/database.js'
import { countDiaries, insertDiary, searchDiaries, searchDiariesByMatch } from './diary-store.js'

test('diaries are segmented on write and retrievable by multi-word Chinese query', () => {
  const db = openDatabase(':memory:')
  try {
    insertDiary(db, {
      content: '今天和主人聊了记忆系统的设计，聊到深夜',
      importance: 0.8,
      emotion: 0.6,
      typeTags: ['日常', '设计'],
    })
    assert.equal(countDiaries(db), 1)

    const stored = db.prepare('select content_seg from diaries').get() as { content_seg: string }
    assert.ok(stored.content_seg.includes('记忆'), stored.content_seg)

    const hits = searchDiaries(db, '记忆系统')
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.typeTags.length, 2)
    assert.equal(typeof hits[0]?.rank, 'number')
  } finally {
    db.close()
  }
})

test('two-character Chinese words are searchable', () => {
  const db = openDatabase(':memory:')
  try {
    insertDiary(db, { content: '本鲸今天有点难过，主人说下周不来了' })
    insertDiary(db, { content: '一起看了海，风很大' })
    const hits = searchDiaries(db, '难过')
    assert.equal(hits.length, 1)
    assert.match(hits[0]?.content ?? '', /难过/)
  } finally {
    db.close()
  }
})

test('bm25 ranks a repeated-term diary above a passing mention', () => {
  const db = openDatabase(':memory:')
  try {
    const focused = insertDiary(db, { content: '记忆 记忆 记忆' })
    insertDiary(db, { content: '今天天气很好，顺便聊了一句记忆，然后就去做饭了，饭很好吃' })
    const hits = searchDiaries(db, '记忆')
    assert.equal(hits.length, 2)
    assert.equal(hits[0]?.id, focused)
    assert.ok((hits[0]?.rank ?? 0) < (hits[1]?.rank ?? 0))
  } finally {
    db.close()
  }
})

test('rebuildIndexes restores a wiped index from content_seg', () => {
  const db = openDatabase(':memory:')
  try {
    insertDiary(db, { content: '纪念日快到了，主人喜欢海' })
    assert.equal(searchDiariesByMatch(db, '"主人"').length, 1)

    db.exec("insert into diaries_fts(diaries_fts) values ('delete-all')")
    assert.equal(searchDiariesByMatch(db, '"主人"').length, 0)

    rebuildIndexes(db)
    assert.equal(searchDiariesByMatch(db, '"主人"').length, 1)
  } finally {
    db.close()
  }
})

test('character fallback finds rephrased Chinese', () => {
  const db = openDatabase(':memory:')
  try {
    insertDiary(db, { content: '和主人一起看了海，风很大' })
    const hits = searchDiaries(db, '看海')
    assert.equal(hits.length, 1)
  } finally {
    db.close()
  }
})

test('empty and punctuation queries never hit the index', () => {
  const db = openDatabase(':memory:')
  try {
    insertDiary(db, { content: '随便写点什么' })
    assert.deepEqual(searchDiaries(db, ''), [])
    assert.deepEqual(searchDiaries(db, '，。！'), [])
  } finally {
    db.close()
  }
})
