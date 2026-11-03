import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { countDiaries } from './diary-store.js'
import { countPoints, purgeExpiredPoints, recordPoint, searchPoints } from './point-store.js'

const subject = { kind: 'user' as const, id: 'local' }

test('identical points merge and promote after the second mention', () => {
  const db = openDatabase(':memory:')
  try {
    const first = recordPoint(db, { subject, text: '主人下周要交房租', importance: 0.6 })
    assert.equal(first.mentions, 1)
    assert.equal(first.promoted, false)
    assert.equal(countDiaries(db), 0)

    const second = recordPoint(db, { subject, text: '主人下周要交房租', importance: 0.6 })
    assert.equal(second.mentions, 2)
    assert.equal(second.promoted, true)
    assert.equal(countDiaries(db), 1)
    assert.equal(countPoints(db, subject), 1)
  } finally {
    db.close()
  }
})

test('a high-importance point promotes immediately', () => {
  const db = openDatabase(':memory:')
  try {
    const point = recordPoint(db, { subject, text: '主人说想去看海', importance: 0.9 })
    assert.equal(point.promoted, true)
    assert.equal(countDiaries(db), 1)
  } finally {
    db.close()
  }
})

test('expired points are purged and not searchable', () => {
  const db = openDatabase(':memory:')
  try {
    recordPoint(db, { subject, text: '过期的事', ttlDays: -1 })
    assert.equal(countPoints(db, subject), 0)
    assert.equal(purgeExpiredPoints(db), 1)
    assert.deepEqual(searchPoints(db, '过期', subject), [])
  } finally {
    db.close()
  }
})

test('points are scoped to their subject', () => {
  const db = openDatabase(':memory:')
  try {
    recordPoint(db, { subject, text: '私聊的事' })
    recordPoint(db, { subject: { kind: 'group', id: 'g1' }, text: '群里发生的事' })
    assert.deepEqual(
      searchPoints(db, '私聊', subject).map((hit) => hit.text),
      ['私聊的事'],
    )
    assert.deepEqual(
      searchPoints(db, '群里', { kind: 'group', id: 'g1' }).map((hit) => hit.text),
      ['群里发生的事'],
    )
  } finally {
    db.close()
  }
})
