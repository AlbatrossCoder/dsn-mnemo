import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import {
  anchorsInWindow,
  listAnchors,
  markAnchorFired,
  markAnchorHandled,
  missedAnchors,
  upsertAnchor,
} from './anchor-store.js'

const subject = { kind: 'user' as const, id: 'local' }

test('upsertAnchor inserts once and updates the same subject/name/date', () => {
  const db = openDatabase(':memory:')
  try {
    const first = upsertAnchor(db, { eventName: '一起看海', targetDate: '2026-11-05', subject })
    const second = upsertAnchor(db, {
      eventName: '一起看海',
      targetDate: '2026-11-05',
      windowDays: 5,
      subject,
    })
    assert.equal(first, second)
    assert.equal(listAnchors(db, subject).length, 1)
    assert.equal(listAnchors(db, subject)[0]?.windowDays, 5)
  } finally {
    db.close()
  }
})

test('anchorsInWindow respects the default and per-anchor window', () => {
  const db = openDatabase(':memory:')
  try {
    upsertAnchor(db, { eventName: '近的', targetDate: '2026-11-04', subject })
    upsertAnchor(db, { eventName: '远的', targetDate: '2026-11-20', subject })
    upsertAnchor(db, { eventName: '只当天', targetDate: '2026-11-01', windowDays: 0, subject })
    upsertAnchor(db, { eventName: '宽的', targetDate: '2026-11-08', windowDays: 10, subject })

    const hits = anchorsInWindow(db, subject, '2026-11-03', 2)
    assert.deepEqual(
      hits.map((anchor) => anchor.eventName).sort(),
      ['宽的', '近的'],
    )
  } finally {
    db.close()
  }
})

test('anchors are ordered by occurrence date', () => {
  const db = openDatabase(':memory:')
  try {
    upsertAnchor(db, { eventName: '后', targetDate: '2026-11-05', subject })
    upsertAnchor(db, { eventName: '前', targetDate: '2026-11-02', subject })
    assert.deepEqual(
      anchorsInWindow(db, subject, '2026-11-03', 3).map((anchor) => anchor.eventName),
      ['前', '后'],
    )
  } finally {
    db.close()
  }
})

test('repeating anchors expand to the nearest occurrence', () => {
  const db = openDatabase(':memory:')
  try {
    // 2026-11-07 is a Saturday; 2026-11-03 is a Tuesday.
    upsertAnchor(db, { eventName: '每周六开黑', targetDate: '2026-11-07', repeat: 'weekly', subject })
    const hits = anchorsInWindow(db, subject, '2026-11-03', 4)
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.occurrenceDate, '2026-11-07')

    // A yearly birthday recurs every year.
    upsertAnchor(db, { eventName: '生日', targetDate: '2025-11-06', repeat: 'yearly', subject })
    const birthday = anchorsInWindow(db, subject, '2026-11-03', 5).find((anchor) => anchor.eventName === '生日')
    assert.equal(birthday?.occurrenceDate, '2026-11-06')
  } finally {
    db.close()
  }
})

test('missed anchors are past the window without being surfaced or handled', () => {
  const db = openDatabase(':memory:')
  try {
    const missed = upsertAnchor(db, { eventName: '交水电费', targetDate: '2026-10-30', subject })
    const surfaced = upsertAnchor(db, { eventName: '已经提醒过', targetDate: '2026-10-29', subject })
    const handled = upsertAnchor(db, { eventName: '已经处理过', targetDate: '2026-10-28', subject })
    markAnchorFired(db, surfaced, '2026-10-29')
    markAnchorHandled(db, handled, '2026-10-28')

    const result = missedAnchors(db, subject, '2026-11-03', 2)
    assert.deepEqual(
      result.map((anchor) => anchor.id),
      [missed],
    )
  } finally {
    db.close()
  }
})

test('subjects do not see each other anchors', () => {
  const db = openDatabase(':memory:')
  try {
    upsertAnchor(db, { eventName: '我的生日', targetDate: '2026-11-03', subject })
    upsertAnchor(db, { eventName: '群纪念日', targetDate: '2026-11-03', subject: { kind: 'group', id: 'g1' } })
    assert.deepEqual(
      anchorsInWindow(db, subject, '2026-11-03', 0).map((anchor) => anchor.eventName),
      ['我的生日'],
    )
    assert.deepEqual(
      anchorsInWindow(db, { kind: 'group', id: 'g1' }, '2026-11-03', 0).map((anchor) => anchor.eventName),
      ['群纪念日'],
    )
  } finally {
    db.close()
  }
})

test('markAnchorFired records one day and is idempotent', () => {
  const db = openDatabase(':memory:')
  try {
    const id = upsertAnchor(db, { eventName: '纪念日', targetDate: '2026-11-03', subject })
    markAnchorFired(db, id, '2026-11-03')
    markAnchorFired(db, id, '2026-11-03')
    assert.equal(listAnchors(db, subject)[0]?.lastFiredOn, '2026-11-03')
  } finally {
    db.close()
  }
})
