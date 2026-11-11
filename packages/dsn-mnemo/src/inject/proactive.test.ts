import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { insertDiary } from '../store/diary-store.js'
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

test('the first two turns carry recent diaries even when the topic does not match', () => {
  const db = openDatabase(':memory:')
  try {
    insertDiary(db, { subjectKind: 'user', subjectId: 'local', content: '和主人一起看了海，风很大', importance: 0.9 })
    const provider = createProactiveText(db, { limit: 2, now: () => NOW })
    assert.match(provider(sessionOf('m1', [user('m1', '帮我写一个排序函数')])), /看了海/)
    assert.match(provider(sessionOf('m2', [user('m2', '今天天气怎么样')])), /看了海/)
  } finally {
    db.close()
  }
})

test('an unrelated turn injects nothing after the opening', () => {
  const db = openDatabase(':memory:')
  try {
    insertDiary(db, { subjectKind: 'user', subjectId: 'local', content: '和主人一起看了海，风很大', importance: 0.9 })
    const provider = createProactiveText(db, { limit: 2, now: () => NOW })
    provider(sessionOf('o1', [user('o1', '你好')]))
    provider(sessionOf('o2', [user('o2', '在吗')]))
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
    provider(sessionOf('o1', [user('o1', '你好')]))
    provider(sessionOf('o2', [user('o2', '在吗')]))
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
    provider(sessionOf('o1', [user('o1', '你好')]))
    provider(sessionOf('o2', [user('o2', '在吗')]))
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
    provider(sessionOf('o1', [user('o1', '你好')]))
    provider(sessionOf('o2', [user('o2', '在吗')]))
    assert.match(provider(sessionOf('m1', [user('m1', '还记得看海吗')])), /看了海/)
    assert.equal(provider(sessionOf('m2', [user('m2', '上次看海那天风大吗')])), '')
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
    provider(sessionOf('o1', [user('o1', '你好')], 's-group'))
    provider(sessionOf('o2', [user('o2', '在吗')], 's-group'))
    const text = provider(sessionOf('m1', [user('m1', '周末吃火锅吗')], 's-group'))
    assert.match(text, /群里约了/)
    assert.doesNotMatch(text, /私下说/)
  } finally {
    db.close()
  }
})

test('capHits enforces both the item cap and the token budget', () => {
  const hits = Array.from({ length: 30 }, (_, index) => ({
    source: 'diary' as const,
    id: index,
    text: 'x'.repeat(100),
    score: 1,
    when: '2026-11-01 10:00:00',
  }))
  assert.equal(capHits(hits, 20, 600).length, 20)
  const long = Array.from({ length: 3 }, (_, index) => ({
    source: 'diary' as const,
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
  assert.match(text, /不是对方刚刚说的/)
  assert.doesNotMatch(text, /不要逐字复述/)
})

test('a QQ source names the subject before the session row exists', () => {
  const db = openDatabase(':memory:')
  try {
    insertDiary(db, { subjectKind: 'user', subjectId: 'local', content: '这是本地的日记，不该出现', importance: 0.9 })
    insertDiary(db, { subjectKind: 'user', subjectId: '10001', content: '和这个人看了海', importance: 0.9 })
    const provider = createProactiveText(db, { limit: 2, now: () => NOW })
    const history = [
      {
        id: 'q1',
        role: 'user',
        content: [{ type: 'text', text: '在吗' }],
        source: { kind: 'qq', userId: '10001' },
      },
    ]
    const text = provider(sessionOf('q1', history, 'whale-new'))
    assert.match(text, /看了海/)
    assert.doesNotMatch(text, /本地的日记/)
  } finally {
    db.close()
  }
})

test('opening turns hide the owner and other groups private diaries', () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 's-group', 1, { kind: 'group', audienceId: 'g1' })
    insertDiary(db, { subjectKind: 'user', subjectId: '84272166', visibility: 'secret', content: '主人的秘密记忆', importance: 0.9 })
    insertDiary(db, { subjectKind: 'user', subjectId: '10001', content: '和这个人看了海', importance: 0.9 })
    insertDiary(db, { subjectKind: 'group', subjectId: 'g1', visibility: 'public', content: '群里约了周末', importance: 0.9 })
    insertDiary(db, { subjectKind: 'group', subjectId: 'g1', visibility: 'private', content: '群里私下的事', importance: 0.9 })
    const provider = createProactiveText(db, { limit: 5, now: () => NOW, ownerId: '84272166' })
    const dm = provider(
      sessionOf(
        'q1',
        [{ id: 'q1', role: 'user', content: [{ type: 'text', text: '在吗' }], source: { kind: 'qq', userId: '10001' } }],
        'whale-dm',
      ),
    )
    assert.match(dm, /看了海/)
    assert.doesNotMatch(dm, /秘密/)
    const group = provider(sessionOf('g1', [user('g1', '大家好')], 's-group'))
    assert.match(group, /群里约了/)
    assert.doesNotMatch(group, /秘密/)
    assert.doesNotMatch(group, /私下/)
    assert.doesNotMatch(group, /看了海/)
  } finally {
    db.close()
  }
})
