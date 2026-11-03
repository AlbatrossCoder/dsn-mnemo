import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { insertDiary } from '../store/diary-store.js'
import { touchSession } from '../store/message-store.js'
import { createConsolidateTool } from './diary-consolidate.js'

function execWithSession(sessionId: string): never {
  return { agent: { session: { id: sessionId } } } as never
}

test('diary_consolidate runs the judgement for the current session', async () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 's-1', 1)
    let asked = ''
    const tool = createConsolidateTool(db, {
      flush: async (sessionId) => {
        asked = sessionId
        insertDiary(db, { sessionId, content: '手动沉淀的一篇日记' })
        return true
      },
    })
    const result = (await tool.execute({}, execWithSession('s-1'))) as { written: boolean; diary_id?: number }
    assert.equal(asked, 's-1')
    assert.equal(result.written, true)
    assert.equal(typeof result.diary_id, 'number')
  } finally {
    db.close()
  }
})

test('diary_consolidate reports a declined judgement', async () => {
  const db = openDatabase(':memory:')
  try {
    const tool = createConsolidateTool(db, { flush: async () => false })
    const result = (await tool.execute({}, execWithSession('s-2'))) as { written: boolean }
    assert.equal(result.written, false)
  } finally {
    db.close()
  }
})

test('diary_consolidate requires a live agent session', async () => {
  const db = openDatabase(':memory:')
  try {
    const tool = createConsolidateTool(db, { flush: async () => true })
    await assert.rejects(tool.execute({}, {} as never), /live agent session/)
  } finally {
    db.close()
  }
})
