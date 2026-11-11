import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { insertDiary, recentDiaries, searchDiaries, type Visibility } from '../store/diary-store.js'
import { insertMessage, searchMessages, touchSession } from '../store/message-store.js'
import { buildMemoryAccess, diaryVisible, sessionVisible, type DiaryRef, type MemoryAccess } from './visibility.js'

const OWNER = 'owner'

function diary(subjectKind: 'user' | 'group', subjectId: string, visibility: Visibility): DiaryRef {
  return { subjectKind, subjectId, visibility }
}

test('group scene reads only that group public diary and that group log', () => {
  const access = buildMemoryAccess({ kind: 'group', id: 'g1' }, OWNER)
  assert.equal(diaryVisible(access, diary('group', 'g1', 'public')), true)
  assert.equal(diaryVisible(access, diary('group', 'g1', 'private')), false)
  assert.equal(diaryVisible(access, diary('group', 'g1', 'secret')), false)
  assert.equal(diaryVisible(access, diary('group', 'g2', 'public')), false)
  assert.equal(diaryVisible(access, diary('user', 'alice', 'public')), false)
  assert.equal(diaryVisible(access, diary('user', OWNER, 'public')), false)
  assert.equal(sessionVisible(access, { kind: 'group', audienceId: 'g1' }), true)
  assert.equal(sessionVisible(access, { kind: 'group', audienceId: 'g2' }), false)
  assert.equal(sessionVisible(access, { kind: 'dm', audienceId: 'alice' }), false)
  assert.equal(sessionVisible(access, { kind: 'dm', audienceId: '' }), false)
})

test('a non-owner dm reads own diaries, public group diaries, and other people except secret', () => {
  const access = buildMemoryAccess({ kind: 'user', id: 'alice' }, OWNER)
  assert.equal(diaryVisible(access, diary('user', 'alice', 'secret')), true)
  assert.equal(diaryVisible(access, diary('user', 'alice', 'private')), true)
  assert.equal(diaryVisible(access, diary('user', OWNER, 'public')), false)
  assert.equal(diaryVisible(access, diary('user', OWNER, 'secret')), false)
  assert.equal(diaryVisible(access, diary('user', 'local', 'public')), false)
  assert.equal(diaryVisible(access, diary('user', 'bob', 'private')), true)
  assert.equal(diaryVisible(access, diary('user', 'bob', 'secret')), false)
  assert.equal(diaryVisible(access, diary('group', 'g1', 'public')), true)
  assert.equal(diaryVisible(access, diary('group', 'g1', 'private')), false)
  assert.equal(sessionVisible(access, { kind: 'dm', audienceId: 'alice' }), true)
  assert.equal(sessionVisible(access, { kind: 'dm', audienceId: OWNER }), false)
  assert.equal(sessionVisible(access, { kind: 'dm', audienceId: 'bob' }), false)
  assert.equal(sessionVisible(access, { kind: 'group', audienceId: 'g2' }), true)
})

test('an owner dm adds the owner secret diaries and still hides other secrets', () => {
  const access = buildMemoryAccess({ kind: 'user', id: OWNER }, OWNER)
  assert.equal(diaryVisible(access, diary('user', OWNER, 'secret')), true)
  assert.equal(diaryVisible(access, diary('user', OWNER, 'public')), true)
  assert.equal(diaryVisible(access, diary('user', 'alice', 'secret')), false)
  assert.equal(diaryVisible(access, diary('user', 'alice', 'private')), true)
  assert.equal(diaryVisible(access, diary('user', 'local', 'secret')), false)
  assert.equal(sessionVisible(access, { kind: 'dm', audienceId: OWNER }), true)
  assert.equal(sessionVisible(access, { kind: 'dm', audienceId: 'alice' }), false)
})

test('search and recent diaries follow the access predicate', () => {
  const db = openDatabase(':memory:')
  try {
    const rows: Array<{ kind: 'user' | 'group'; id: string; visibility: Visibility; label: string }> = [
      { kind: 'user', id: 'alice', visibility: 'private', label: 'alice-private' },
      { kind: 'user', id: 'alice', visibility: 'secret', label: 'alice-secret' },
      { kind: 'user', id: 'alice', visibility: 'public', label: 'alice-public' },
      { kind: 'user', id: OWNER, visibility: 'secret', label: 'owner-secret' },
      { kind: 'user', id: OWNER, visibility: 'public', label: 'owner-public' },
      { kind: 'user', id: 'bob', visibility: 'public', label: 'bob-public' },
      { kind: 'user', id: 'bob', visibility: 'private', label: 'bob-private' },
      { kind: 'user', id: 'bob', visibility: 'secret', label: 'bob-secret' },
      { kind: 'user', id: 'local', visibility: 'private', label: 'local-private' },
      { kind: 'group', id: 'g1', visibility: 'public', label: 'g1-public' },
      { kind: 'group', id: 'g1', visibility: 'private', label: 'g1-private' },
      { kind: 'group', id: 'g1', visibility: 'secret', label: 'g1-secret' },
      { kind: 'group', id: 'g2', visibility: 'public', label: 'g2-public' },
    ]
    for (const row of rows) {
      insertDiary(db, {
        subjectKind: row.kind,
        subjectId: row.id,
        visibility: row.visibility,
        content: `${row.label}的记忆`,
      })
    }

    const scenes: MemoryAccess[] = [
      buildMemoryAccess({ kind: 'group', id: 'g1' }, OWNER),
      buildMemoryAccess({ kind: 'user', id: 'alice' }, OWNER),
      buildMemoryAccess({ kind: 'user', id: OWNER }, OWNER),
    ]
    for (const access of scenes) {
      const want = rows
        .filter((row) => diaryVisible(access, { subjectKind: row.kind, subjectId: row.id, visibility: row.visibility }))
        .map((row) => `${row.label}的记忆`)
        .sort()
      const found = searchDiaries(db, '记忆', 30, 'and', access)
        .map((hit) => hit.content)
        .sort()
      assert.deepEqual(found, want, JSON.stringify(access.scene))
      const recent = recentDiaries(db, access, 30)
        .map((hit) => hit.content)
        .sort()
      assert.deepEqual(recent, want, `recent ${access.scene.kind}:${access.scene.id}`)
    }
  } finally {
    db.close()
  }
})

test('search messages follow session access', () => {
  const db = openDatabase(':memory:')
  try {
    const sessions: Array<{ id: string; kind: 'dm' | 'group'; audience: string | null; label: string }> = [
      { id: 'alice', kind: 'dm', audience: 'alice', label: 'alice' },
      { id: 'owner', kind: 'dm', audience: OWNER, label: 'owner' },
      { id: 'bob', kind: 'dm', audience: 'bob', label: 'bob' },
      { id: 'local-null', kind: 'dm', audience: null, label: 'local' },
      { id: 'g1', kind: 'group', audience: 'g1', label: 'g1' },
      { id: 'g2', kind: 'group', audience: 'g2', label: 'g2' },
    ]
    for (const row of sessions) {
      if (row.audience === null) touchSession(db, row.id, 1)
      else touchSession(db, row.id, 1, { kind: row.kind, audienceId: row.audience })
      insertMessage(db, {
        sessionId: row.id,
        seq: 1,
        turn: 1,
        role: 'user',
        content: `${row.label}的记忆`,
        raw: '{}',
      })
    }

    const expectSessions = (access: MemoryAccess, ids: readonly string[]) => {
      const found = searchMessages(db, '记忆', 20, access)
        .map((hit) => hit.sessionId)
        .sort()
      assert.deepEqual(found, [...ids].sort(), JSON.stringify(access.scene))
    }
    expectSessions(buildMemoryAccess({ kind: 'group', id: 'g1' }, OWNER), ['g1'])
    expectSessions(buildMemoryAccess({ kind: 'user', id: 'alice' }, OWNER), ['alice', 'g1', 'g2'])
    expectSessions(buildMemoryAccess({ kind: 'user', id: OWNER }, OWNER), ['owner', 'g1', 'g2'])
    expectSessions(buildMemoryAccess({ kind: 'user', id: 'local' }, OWNER), ['local-null', 'g1', 'g2'])
  } finally {
    db.close()
  }
})
