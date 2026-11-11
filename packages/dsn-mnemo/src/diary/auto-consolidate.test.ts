import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { searchDiaries } from '../store/diary-store.js'
import { getSubjectLedger } from '../store/ledger-store.js'
import { insertMessage, touchSession } from '../store/message-store.js'
import { buildAutoDiary, writeAutoDiary } from './auto-consolidate.js'
import { createPendingDiaryText } from './pending.js'

const NOW = new Date('2026-11-03T12:00:00Z')

function session(marker: string) {
  return {
    id: 's1',
    deriveMessages: () => [{ role: 'user', id: marker, source: { kind: 'qq' } }],
  }
}

test('buildAutoDiary keeps a short first-person clip list', () => {
  const text = buildAutoDiary([
    { role: 'user', content: '今天好冷' },
    { role: 'assistant', content: '光缆还亮着。' },
  ])
  assert.match(text, /自动整理/)
  assert.match(text, /对方：今天好冷/)
  assert.match(text, /我：光缆还亮着/)
})

test('coming back after ignoring a diary hint auto-files the old stretch', () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 's1', 1, { kind: 'dm', audienceId: 'alice' })
    insertMessage(db, {
      sessionId: 's1',
      seq: 1,
      turn: 1,
      role: 'user',
      content: '我们约好下周去看海，记得带那张暖色的图，还有纸船。',
      raw: '{}',
    })
    insertMessage(db, {
      sessionId: 's1',
      seq: 2,
      turn: 1,
      role: 'assistant',
      content: '好，我记着。',
      raw: '{}',
    })
    db.prepare("update messages set created_at = '2026-11-03 10:00:00'").run()
    db.prepare("update sessions set last_turn_end_at = '2026-11-03 11:00:00' where id = 's1'").run()

    const pending = createPendingDiaryText(db, {
      idleMs: 20 * 60_000,
      maxTurns: 30,
      maxChars: 12_000,
      now: () => NOW,
    })
    assert.match(pending(session('p1')), /diary_write/)
    assert.ok(getSubjectLedger(db, { kind: 'user', id: 'alice' })?.diaryPromptedAt)

    // Same gap after the hint — stay quiet, do not auto-file yet.
    db.prepare("update subject_ledger set diary_prompted_at = '2026-11-03 11:00:00'").run()
    assert.equal(pending(session('p2')), '')
    assert.equal(getSubjectLedger(db, { kind: 'user', id: 'alice' })?.diaryWrittenAt ?? null, null)

    // New lines after the quiet gap → auto-file the old stretch.
    insertMessage(db, {
      sessionId: 's1',
      seq: 3,
      turn: 2,
      role: 'user',
      content: '我回来了，还想再聊两句看海的事。',
      raw: '{}',
    })
    db.prepare("update messages set created_at = '2026-11-03 11:50:00' where seq = 3").run()
    assert.equal(pending(session('p3')), '')
    assert.ok(getSubjectLedger(db, { kind: 'user', id: 'alice' })?.diaryWrittenAt)
    assert.match(searchDiaries(db, '看海', 5, 'and', { kind: 'user', id: 'alice' })[0]?.content ?? '', /自动整理/)
  } finally {
    db.close()
  }
})

test('writeAutoDiary forces owner diaries to secret', () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 's1', 1, { kind: 'dm', audienceId: 'owner-1' })
    const id = writeAutoDiary({
      db,
      subject: { kind: 'user', id: 'owner-1' },
      sessionId: 's1',
      messages: [{ role: 'user', content: '这是只能跟你说的事' }],
      owner: { ownerId: 'owner-1' },
    })
    const row = db.prepare('select visibility from diaries where id = ?').get(id) as { visibility: string }
    assert.equal(row.visibility, 'secret')
  } finally {
    db.close()
  }
})
