import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { insertDiary } from '../store/diary-store.js'
import { insertPoint } from '../store/point-store.js'
import {
  capHits,
  createProactiveText,
  isProactiveTrigger,
  lastHumanTurn,
  renderProactive,
  type ProactiveSession,
} from './proactive.js'

const NOW = new Date('2026-11-03T00:00:00Z')

function turn(text: string, id = 'm1', sourceKind = 'user'): ProactiveSession {
  return {
    id: 's1',
    deriveMessages: () => [
      { id: 'sys', role: 'system', content: [{ type: 'text', text: 'you are…' }], source: { kind: 'system-prompt' } },
      { id, role: 'user', content: [{ type: 'text', text }], source: { kind: sourceKind } },
    ],
  }
}

test('time references and emotion words trigger, neutral text does not', () => {
  assert.equal(isProactiveTrigger('你还记得上次我们去哪了吗'), true)
  assert.equal(isProactiveTrigger('今天有点难过'), true)
  assert.equal(isProactiveTrigger('帮我写一个排序函数'), false)
  assert.equal(isProactiveTrigger('嗯'), false)
})

test('lastHumanTurn skips injected snapshots and assistant messages', () => {
  const session: ProactiveSession = {
    id: 's1',
    deriveMessages: () => [
      { id: 'a', role: 'user', content: [{ type: 'text', text: '真实提问' }], source: { kind: 'user' } },
      { id: 'b', role: 'assistant', content: [{ type: 'text', text: '回答' }], source: { kind: 'model' } },
      { id: 'c', role: 'user', content: [{ type: 'text', text: '注入的快照' }], source: { kind: 'recall' } },
    ],
  }
  assert.deepEqual(lastHumanTurn(session), { id: 'a', text: '真实提问' })
})

test('no trigger yields an empty contribution', () => {
  const db = openDatabase(':memory:')
  try {
    insertDiary(db, { subjectKind: 'user', subjectId: 'local', content: '和主人一起看了海，风很大', importance: 0.9 })
    const provider = createProactiveText(db, { limit: 2, now: () => NOW })
    assert.equal(provider(turn('帮我写一个排序函数')), '')
  } finally {
    db.close()
  }
})

test('a triggered turn surfaces matching diaries', () => {
  const db = openDatabase(':memory:')
  try {
    insertDiary(db, { subjectKind: 'user', subjectId: 'local', content: '和主人一起看了海，风很大，主人笑了很久', importance: 0.9 })
    const provider = createProactiveText(db, { limit: 2, now: () => NOW })
    const text = provider(turn('你还记得上次看海吗', 'm1'))
    assert.match(text, /看了海/)
    assert.match(text, /长期记忆/)
  } finally {
    db.close()
  }
})

test('the same diary is not surfaced twice in one session', () => {
  const db = openDatabase(':memory:')
  try {
    insertDiary(db, { subjectKind: 'user', subjectId: 'local', content: '和主人一起看了海，风很大', importance: 0.9 })
    const provider = createProactiveText(db, { limit: 2, now: () => NOW })
    assert.match(provider(turn('还记得看海吗', 'm1')), /看了海/)
    assert.equal(provider(turn('上次看海那天风大吗', 'm2')), '')
  } finally {
    db.close()
  }
})

test('repeated assemblies for one message are byte-identical', () => {
  const db = openDatabase(':memory:')
  try {
    insertDiary(db, { subjectKind: 'user', subjectId: 'local', content: '一起看了海', importance: 0.9 })
    const provider = createProactiveText(db, { limit: 2, now: () => NOW })
    const session = turn('还记得看海吗', 'm1')
    assert.equal(provider(session), provider(session))
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
    const text = provider(turn('你还记得交房租的事吗', 'm1'))
    assert.match(text, /房租/)
    assert.match(text, /记忆点/)
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
