import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { insertDiary } from '../store/diary-store.js'
import { insertPoint } from '../store/point-store.js'
import { touchSession } from '../store/message-store.js'
import { capHits, createProactiveText, renderProactive, type ProactiveSession } from './proactive.js'

const NOW = new Date('2026-11-03T00:00:00Z')

function user(id: string, text: string) {
  const withId = { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
  return withId
}

function sessionOf(id: string, history: readonly unknown[], sessionId = 's1'): ProactiveSession {
  return { id: sessionId, deriveMessages: () => history }
}

test('an unrelated turn injects nothing', () => {
  const db = openDatabase(':memory:')
  try {
    insertDiary(db, { subjectKind: 'user', subjectId: 'local', content: '和主人一起看了海，风很大', importance: 0.9 })
    const provider = createProactiveText(db, { limit: 2, now: () => NOW })
    assert.equal(provider(sessionOf('m1', [user('m1', '帮我写一个排序函数')])), '')
  } finally {
    db.close()
  }
})

test('a matching topic surfaces diaries', () => {
  const db = openDatabase(':memory:')
  try {
    insertDiary(db, { subjectKind: 'user', subjectId: 'local', content: '和主人一起看了海，风很大，主人笑了很久', importance: 0.9 })
    const provider = createProactiveText(db, { limit: 2, now: () => NOW })
    const text = provider(sessionOf('m1', [user('m1', '你还记得上次看海吗')]))
    assert.match(text, /看了海/)
    assert.match(text, /长期记忆/)
  } finally {
    db.close()
  }
})

test('a burst of short messages still carries the topic', () => {
  const db = openDatabase(':memory:')
  try {
    insertDiary(db, { subjectKind: 'user', subjectId: 'local', content: '周末去吃了上次那家火锅店', importance: 0.8 })
    const provider = createProactiveText(db, { limit: 5, now: () => NOW })
    const history = [user('m1', '我们周末去吃火锅吧'), user('m2', '就上次那家')]
    const text = provider(sessionOf('m2', history))
    assert.match(text, /火锅/)
  } finally {
    db.close()
  }
})

test('the same memory is not injected again inside the cooldown', () => {
  const db = openDatabase(':memory:')
  try {
    insertDiary(db, { subjectKind: 'user', subjectId: 'local', content: '和主人一起看了海，风很大', importance: 0.9 })
    const provider = createProactiveText(db, { limit: 2, now: () => NOW, cooldownTurns: 10 })
    assert.match(provider(sessionOf('m1', [user('m1', '还记得看海吗')])), /看了海/)
    assert.equal(provider(sessionOf('m2', [user('m2', '上次看海那天风大吗')])), '')
  } finally {
    db.close()
  }
})

test('memory points surface alongside diaries by association', () => {
  const db = openDatabase(':memory:')
  try {
    insertPoint(db, {
      subject: { kind: 'user', id: 'local' },
      text: '主人下周要交房租，别忘了',
      importance: 0.9,
    })
    const provider = createProactiveText(db, { limit: 20, now: () => NOW })
    const text = provider(sessionOf('m1', [user('m1', '你还记得交房租的事吗')]))
    assert.match(text, /房租/)
    assert.match(text, /记忆点/)
  } finally {
    db.close()
  }
})

test('group auto-injection is public-only', () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 's-group', 1, { kind: 'group', audienceId: 'g1' })
    insertDiary(db, {
      subjectKind: 'group',
      subjectId: 'g1',
      visibility: 'public',
      content: '群里约了周末去吃火锅',
      importance: 0.8,
    })
    insertDiary(db, {
      subjectKind: 'group',
      subjectId: 'g1',
      visibility: 'private',
      content: '某个群友私下说要去吃火锅',
      importance: 0.8,
    })
    const provider = createProactiveText(db, { limit: 5, now: () => NOW })
    const text = provider(sessionOf('m1', [user('m1', '周末吃火锅吗')], 's-group'))
    assert.match(text, /群里约了/)
    assert.doesNotMatch(text, /私下说/)
  } finally {
    db.close()
  }
})

test('capHits enforces both the item cap and the token budget', () => {
  const hits = Array.from({ length: 30 }, (_, index) => ({
    source: 'point' as const,
    id: index,
    text: 'x'.repeat(100),
    score: 1,
    when: '2026-11-01 10:00:00',
  }))
  assert.equal(capHits(hits, 20, 600).length, 20)
  const long = Array.from({ length: 3 }, (_, index) => ({
    source: 'point' as const,
    id: index,
    text: '记'.repeat(600),
    score: 1,
    when: '2026-11-01 10:00:00',
  }))
  assert.equal(capHits(long, 20, 600).length, 1)
})

test('renderProactive marks memory as non-authoritative', () => {
  const text = renderProactive([{ source: 'diary', id: 1, text: '一起看了海', score: 1, when: '2026-11-01 10:00:00' }])
  assert.match(text, /2026-11-01/)
  assert.match(text, /不要逐字复述/)
})
