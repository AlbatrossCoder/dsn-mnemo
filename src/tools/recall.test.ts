import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { insertDiary } from '../store/diary-store.js'
import { insertMessage, touchSession } from '../store/message-store.js'
import { createRecallTool, rankDiaries, rankLogs, recall } from './recall.js'

const NOW = new Date('2026-11-03T00:00:00Z')

function setCreatedAt(db: ReturnType<typeof openDatabase>, table: 'diaries' | 'messages', id: number, when: string) {
  db.prepare(`update ${table} set created_at = ? where id = ?`).run(when, id)
}

test('diary ranking prefers importance when BM25 ties', () => {
  const db = openDatabase(':memory:')
  try {
    const important = insertDiary(db, { content: '记忆 很重要', importance: 0.9 })
    const minor = insertDiary(db, { content: '记忆 不重要', importance: 0.1 })
    setCreatedAt(db, 'diaries', important, '2026-11-01 00:00:00')
    setCreatedAt(db, 'diaries', minor, '2026-11-01 00:00:00')

    const hits = rankDiaries(db, '记忆', 5, NOW)
    assert.equal(hits.length, 2)
    assert.equal(hits[0]?.id, important)
    assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0))
  } finally {
    db.close()
  }
})

test('diary ranking decays with age', () => {
  const db = openDatabase(':memory:')
  try {
    const fresh = insertDiary(db, { content: '记忆 新鲜', importance: 0.5 })
    const stale = insertDiary(db, { content: '记忆 陈旧', importance: 0.5 })
    setCreatedAt(db, 'diaries', fresh, '2026-11-02 00:00:00')
    setCreatedAt(db, 'diaries', stale, '2020-01-01 00:00:00')

    const hits = rankDiaries(db, '记忆', 5, NOW)
    assert.equal(hits[0]?.id, fresh)
    assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0))
  } finally {
    db.close()
  }
})

test('log scope returns role-tagged transcript lines', () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 's1', 1)
    insertMessage(db, { sessionId: 's1', seq: 1, turn: 1, role: 'user', content: '下周三去看海', raw: '{}' })
    const hits = rankLogs(db, '看海', 5, NOW)
    assert.equal(hits.length, 1)
    assert.match(hits[0]?.text ?? '', /^\[user\] 下周三去看海$/)
  } finally {
    db.close()
  }
})

test('recall returns an empty list for unmatched or empty queries', () => {
  const db = openDatabase(':memory:')
  try {
    assert.deepEqual(recall(db, '不存在的词', 'diary', 5, NOW), [])
    assert.deepEqual(recall(db, '   ', 'log', 5, NOW), [])
  } finally {
    db.close()
  }
})

test('limit caps the number of hits', () => {
  const db = openDatabase(':memory:')
  try {
    for (let index = 0; index < 6; index += 1) {
      insertDiary(db, { content: `记忆 第 ${index} 条`, importance: 0.5 })
    }
    assert.equal(rankDiaries(db, '记忆', 3, NOW).length, 3)
  } finally {
    db.close()
  }
})

test('recall hits only expose declared output fields', async () => {
  const db = openDatabase(':memory:')
  try {
    insertDiary(db, { content: '一起看了海，风很大', importance: 0.7 })
    const tool = createRecallTool(db, { diaryLimit: 5, logLimit: 5, now: () => NOW })
    const result = (await tool.execute({ query: '海' }, {} as never)) as {
      results: Array<Record<string, unknown>>
    }
    assert.equal(result.results.length, 1)
    assert.deepEqual(Object.keys(result.results[0] ?? {}).sort(), ['id', 'score', 'source', 'text', 'when'])
  } finally {
    db.close()
  }
})

test('the recall tool executes and reports its scope', async () => {
  const db = openDatabase(':memory:')
  try {
    insertDiary(db, { content: '一起看了海，风很大', importance: 0.7 })
    const tool = createRecallTool(db, { diaryLimit: 5, logLimit: 5, now: () => NOW })
    assert.equal(tool.name, 'recall')
    const exec = {} as never
    const result = (await tool.execute({ query: '看海' }, exec)) as {
      scope: string
      results: unknown[]
    }
    assert.equal(result.scope, 'diary')
    assert.equal(result.results.length, 1) // 字符兜底让「看海」命中「看了海」
    const second = (await tool.execute({ query: '海' }, exec)) as { results: unknown[] }
    assert.equal(second.results.length, 1)
  } finally {
    db.close()
  }
})
