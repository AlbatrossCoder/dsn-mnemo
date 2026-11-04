import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { createAnchorTool } from './anchor-upsert.js'
import { listAnchors } from '../store/anchor-store.js'

const exec = {} as never

test('anchor_upsert stores a valid date', async () => {
  const db = openDatabase(':memory:')
  try {
    const tool = createAnchorTool(db)
    const result = (await tool.execute(
      { event_name: '一起看海', target_date: '2026-11-05', tone_hint: '轻一点提' },
      exec,
    )) as { event_name: string; target_date: string }
    assert.equal(result.event_name, '一起看海')
    assert.equal(result.target_date, '2026-11-05')
    assert.equal(listAnchors(db).length, 1)
    assert.equal(listAnchors(db)[0]?.toneHint, '轻一点提')
  } finally {
    db.close()
  }
})

test('anchor_upsert rejects impossible dates', async () => {
  const db = openDatabase(':memory:')
  try {
    const tool = createAnchorTool(db)
    await assert.rejects(tool.execute({ event_name: '错日期', target_date: '2026-02-31' }, exec), /real calendar date/)
    await assert.rejects(tool.execute({ event_name: '错格式', target_date: '2026/11/05' }, exec), /real calendar date/)
    assert.equal(listAnchors(db).length, 0)
  } finally {
    db.close()
  }
})

test('anchor_upsert updates instead of duplicating', async () => {
  const db = openDatabase(':memory:')
  try {
    const tool = createAnchorTool(db)
    await tool.execute({ event_name: '生日', target_date: '2026-11-05' }, exec)
    await tool.execute({ event_name: '生日', target_date: '2026-11-05', window_days: 7 }, exec)
    const anchors = listAnchors(db)
    assert.equal(anchors.length, 1)
    assert.equal(anchors[0]?.windowDays, 7)
  } finally {
    db.close()
  }
})
