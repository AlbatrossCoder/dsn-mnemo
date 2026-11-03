import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MEMORY_DB, migrate, openDatabase, rebuildIndexes, schemaVersion } from './database.js'
import { SCHEMA_VERSION } from './schema.js'
import { searchDiaries } from '../store/diary-store.js'

test('migrations are idempotent across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mnemo-db-'))
  const file = join(dir, 'nested', 'memory.db')
  try {
    const first = openDatabase(file)
    assert.equal(schemaVersion(first), SCHEMA_VERSION)
    const tables = first
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((row) => String((row as { name: string }).name))
    for (const table of ['messages', 'diaries', 'anchors', 'sessions', 'work_state', 'diary_revisions']) {
      assert.ok(tables.includes(table), `${table} missing; got ${tables.join(', ')}`)
    }
    first.close()

    const second = openDatabase(file)
    assert.equal(schemaVersion(second), SCHEMA_VERSION)
    assert.equal(migrate(second), SCHEMA_VERSION)
    const mode = second.prepare('pragma journal_mode').get() as { journal_mode: string }
    assert.equal(mode.journal_mode, 'wal')
    second.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foreign keys are enforced', () => {
  const db = openDatabase(MEMORY_DB)
  try {
    assert.throws(() =>
      db
        .prepare(
          `insert into messages(session_id, turn, role, content, content_seg)
           values ('missing-session', 1, 'user', 'hi', 'hi')`,
        )
        .run(),
    )
  } finally {
    db.close()
  }
})

test('empty database searches cleanly', () => {
  const db = openDatabase(MEMORY_DB)
  try {
    assert.deepEqual(searchDiaries(db, '记忆'), [])
    assert.deepEqual(searchDiaries(db, '   '), [])
  } finally {
    db.close()
  }
})

test('rebuildIndexes is safe on an empty database', () => {
  const db = openDatabase(MEMORY_DB)
  try {
    rebuildIndexes(db)
    assert.deepEqual(searchDiaries(db, '记忆'), [])
  } finally {
    db.close()
  }
})
