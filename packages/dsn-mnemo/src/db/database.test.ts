import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { MEMORY_DB, migrate, openDatabase, rebuildIndexes, schemaVersion } from './database.js'
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js'
import { searchDiaries } from '../store/diary-store.js'

test('v2 migration backfills legacy memories onto the local user', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mnemo-v1-'))
  const file = join(dir, 'memory.db')
  try {
    const legacy = new DatabaseSync(file)
    legacy.exec('pragma journal_mode = wal')
    legacy.exec(MIGRATIONS[0] as string)
    legacy.exec('pragma user_version = 1')
    legacy.exec("insert into sessions(id) values ('s1')")
    legacy.exec(
      "insert into messages(session_id, seq, turn, role, content, content_seg, raw) values ('s1', 1, 1, 'user', '旧消息', '旧消息', '{}')",
    )
    legacy.exec("insert into diaries(session_id, content, content_seg) values ('s1', '旧日记', '旧日记')")
    legacy.exec("insert into anchors(event_name, target_date) values ('生日', '2026-01-01')")
    legacy.close()

    const db = openDatabase(file)
    assert.equal(schemaVersion(db), SCHEMA_VERSION)
    const session = db.prepare('select kind, audience_id from sessions').get() as {
      kind: string
      audience_id: string
    }
    assert.deepEqual({ ...session }, { kind: 'dm', audience_id: 'local' })
    const diary = db.prepare('select subject_kind, subject_id, visibility from diaries').get() as {
      subject_kind: string
      subject_id: string
      visibility: string
    }
    assert.deepEqual({ ...diary }, { subject_kind: 'user', subject_id: 'local', visibility: 'private' })
    const anchor = db.prepare('select subject_kind, subject_id, repeat from anchors').get() as {
      subject_kind: string
      subject_id: string
      repeat: string
    }
    assert.deepEqual({ ...anchor }, { subject_kind: 'user', subject_id: 'local', repeat: 'none' })
    const message = db.prepare('select speaker_id, addressed from messages').get() as {
      speaker_id: string | null
      addressed: number
    }
    assert.deepEqual({ ...message }, { speaker_id: null, addressed: 0 })
    db.close()
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Windows may briefly keep WAL handles; the temp directory is disposable.
    }
  }
})

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
    for (const table of [
      'messages',
      'diaries',
      'anchors',
      'sessions',
      'work_state',
      'diary_revisions',
      'portraits',
      'mind_states',
      'bonds',
      'subject_ledger',
    ]) {
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
