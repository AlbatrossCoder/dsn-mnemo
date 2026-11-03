import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { insertDiary } from './diary-store.js'
import { insertMessage, touchSession } from './message-store.js'
import { refreshRelationStage, relationScore, stageForScore } from './relation.js'

test('relation score counts sessions once and diaries half', () => {
  assert.equal(relationScore(3, 4), 5)
  assert.equal(relationScore(1, 1), 1.5)
})

test('stage thresholds match the design', () => {
  assert.equal(stageForScore(0), 'initial')
  assert.equal(stageForScore(4.9), 'initial')
  assert.equal(stageForScore(5), 'familiar')
  assert.equal(stageForScore(19.9), 'familiar')
  assert.equal(stageForScore(20), 'close')
})

test('refresh persists the stage and grows with diaries', () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 's1', 1)
    insertMessage(db, { sessionId: 's1', seq: 1, turn: 1, role: 'user', content: '你好', raw: '{}' })
    assert.equal(refreshRelationStage(db, 's1'), 'initial')

    for (let index = 0; index < 8; index += 1) {
      insertDiary(db, { sessionId: 's1', content: `第 ${index} 篇日记` })
    }
    assert.equal(refreshRelationStage(db, 's1'), 'familiar')

    for (let index = 0; index < 30; index += 1) {
      insertDiary(db, { sessionId: 's1', content: `补充日记 ${index}` })
    }
    assert.equal(refreshRelationStage(db, 's1'), 'close')

    const row = db.prepare("select relation_stage from sessions where id = 's1'").get() as {
      relation_stage: string
    }
    assert.equal(row.relation_stage, 'close')
  } finally {
    db.close()
  }
})
