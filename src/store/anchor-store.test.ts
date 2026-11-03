import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { anchorsInWindow, listAnchors, markAnchorFired, upsertAnchor } from './anchor-store.js'

test('upsertAnchor inserts once and updates the same name/date', () => {
  const db = openDatabase(':memory:')
  try {
    const first = upsertAnchor(db, { eventName: '一起看海', targetDate: '2026-11-05' })
    const second = upsertAnchor(db, { eventName: '一起看海', targetDate: '2026-11-05', windowDays: 5 })
    assert.equal(first, second)
    assert.equal(listAnchors(db).length, 1)
    assert.equal(listAnchors(db)[0]?.windowDays, 5)
  } finally {
    db.close()
  }
})

test('anchorsInWindow respects the default and per-anchor window', () => {
  const db = openDatabase(':memory:')
  try {
    upsertAnchor(db, { eventName: '近的', targetDate: '2026-11-04' })
    upsertAnchor(db, { eventName: '远的', targetDate: '2026-11-20' })
    upsertAnchor(db, { eventName: '只当天', targetDate: '2026-11-01', windowDays: 0 })
    upsertAnchor(db, { eventName: '宽的', targetDate: '2026-11-08', windowDays: 10 })

    const hits = anchorsInWindow(db, '2026-11-03', 2)
    assert.deepEqual(
      hits.map((anchor) => anchor.eventName).sort(),
      ['宽的', '近的'],
    )
  } finally {
    db.close()
  }
})

test('anchors are ordered by target date', () => {
  const db = openDatabase(':memory:')
  try {
    upsertAnchor(db, { eventName: '后', targetDate: '2026-11-05' })
    upsertAnchor(db, { eventName: '前', targetDate: '2026-11-02' })
    assert.deepEqual(
      anchorsInWindow(db, '2026-11-03', 3).map((anchor) => anchor.eventName),
      ['前', '后'],
    )
  } finally {
    db.close()
  }
})

test('markAnchorFired records one day and is idempotent', () => {
  const db = openDatabase(':memory:')
  try {
    const id = upsertAnchor(db, { eventName: '纪念日', targetDate: '2026-11-03' })
    markAnchorFired(db, id, '2026-11-03')
    markAnchorFired(db, id, '2026-11-03')
    assert.equal(listAnchors(db)[0]?.lastFiredOn, '2026-11-03')
  } finally {
    db.close()
  }
})
