import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { countDiaries, insertDiary } from '../store/diary-store.js'
import { insertMessage, touchSession } from '../store/message-store.js'
import { DiaryEngine, type Scheduler } from './engine.js'

const DIARY_REPLY = [
  'IMPORTANCE: 0.8',
  'EMOTION: 0.6',
  'TAGS: 日常, 约定',
  '',
  '今天和主人聊了记忆系统的设计，聊到很晚。',
].join('\n')

function seedSession(db: ReturnType<typeof openDatabase>, id: string, texts: string[]): void {
  touchSession(db, id, 1)
  texts.forEach((text, index) => {
    insertMessage(db, {
      sessionId: id,
      seq: index + 1,
      turn: 1,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: text,
      raw: '{}',
    })
  })
}

function makeScheduler(): { scheduler: Scheduler; entries: Array<{ id: number; fn: () => void; ms: number }>; cleared: Set<number> } {
  const entries: Array<{ id: number; fn: () => void; ms: number }> = []
  const cleared = new Set<number>()
  let next = 1
  return {
    entries,
    cleared,
    scheduler: {
      set(callback, delayMs) {
        const id = next
        next += 1
        entries.push({ id, fn: callback, ms: delayMs })
        return id
      },
      clear(handle) {
        cleared.add(handle as number)
      },
    },
  }
}

test('an important cue judges immediately instead of waiting', async () => {
  const db = openDatabase(':memory:')
  try {
    seedSession(db, 's1', ['今天是我的生日，主人送了我一个礼物', '生日快乐，今天一定很难忘'])
    const { scheduler, entries } = makeScheduler()
    const engine = new DiaryEngine({
      db,
      generate: async () => DIARY_REPLY,
      idleMs: 1000,
      maxPerSession: 3,
      scheduler,
    })
    engine.noteTurnEnd('s1')
    assert.equal(entries.length, 0, 'must not arm the idle timer')
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(countDiaries(db), 1)
    engine.dispose()
  } finally {
    db.close()
  }
})

test('a long conversation judges immediately', async () => {
  const db = openDatabase(':memory:')
  try {
    seedSession(db, 's1', ['第一句话', '回复一', '第二句话', '回复二', '第三句话', '回复三'])
    const { scheduler, entries } = makeScheduler()
    const engine = new DiaryEngine({
      db,
      generate: async () => DIARY_REPLY,
      idleMs: 1000,
      maxPerSession: 3,
      maxTurns: 2,
      scheduler,
    })
    engine.noteTurnEnd('s1')
    assert.equal(entries.length, 0, 'length trigger must not arm the idle timer')
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(countDiaries(db), 1)
    engine.dispose()
  } finally {
    db.close()
  }
})

test('a quiet short turn falls back to the idle timer', () => {
  const db = openDatabase(':memory:')
  try {
    seedSession(db, 's1', ['今天天气不错', '适合出去走走'])
    const { scheduler, entries } = makeScheduler()
    const engine = new DiaryEngine({
      db,
      generate: async () => DIARY_REPLY,
      idleMs: 1000,
      maxPerSession: 3,
      scheduler,
    })
    engine.noteTurnEnd('s1')
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.ms, 1000)
    engine.dispose()
  } finally {
    db.close()
  }
})

test('turn end arms one idle timer and activity cancels it', () => {
  const db = openDatabase(':memory:')
  try {
    const { scheduler, entries, cleared } = makeScheduler()
    const engine = new DiaryEngine({
      db,
      generate: async () => DIARY_REPLY,
      idleMs: 1800_000,
      maxPerSession: 3,
      scheduler,
    })
    engine.noteTurnEnd('s1')
    engine.noteTurnEnd('s1')
    assert.equal(entries.length, 2)
    assert.equal(cleared.size, 1)
    assert.equal(engine.pending, 1)

    engine.noteActivity('s1')
    assert.equal(engine.pending, 0)
    assert.equal(cleared.size, 2)
    engine.dispose()
  } finally {
    db.close()
  }
})

test('the armed timer triggers a judgement', async () => {
  const db = openDatabase(':memory:')
  try {
    seedSession(db, 's1', ['今天聊了记忆系统的设计', '聊到很晚，我有点困了'])
    const { scheduler, entries } = makeScheduler()
    const engine = new DiaryEngine({
      db,
      generate: async () => DIARY_REPLY,
      idleMs: 1000,
      maxPerSession: 3,
      scheduler,
    })
    engine.noteTurnEnd('s1')
    entries[0]?.fn()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(countDiaries(db), 1)
    engine.dispose()
  } finally {
    db.close()
  }
})

test('flush writes a diary with parsed scores and tags', async () => {
  const db = openDatabase(':memory:')
  try {
    seedSession(db, 's1', ['今天聊了记忆系统的设计', '聊到很晚，我有点困了'])
    const engine = new DiaryEngine({ db, generate: async () => DIARY_REPLY, idleMs: 1000, maxPerSession: 3 })
    assert.equal(await engine.flush('s1'), true)
    const row = db.prepare('select content, importance, emotion, type_tags from diaries').get() as {
      content: string
      importance: number
      emotion: number
      type_tags: string
    }
    assert.match(row.content, /记忆系统/)
    assert.equal(row.importance, 0.8)
    assert.equal(row.type_tags, '日常,约定')
    engine.dispose()
  } finally {
    db.close()
  }
})

test('NO_DIARY writes nothing', async () => {
  const db = openDatabase(':memory:')
  try {
    seedSession(db, 's1', ['今天聊了记忆系统的设计', '聊到很晚'])
    const engine = new DiaryEngine({ db, generate: async () => 'NO_DIARY', idleMs: 1000, maxPerSession: 3 })
    assert.equal(await engine.flush('s1'), false)
    assert.equal(countDiaries(db), 0)
    engine.dispose()
  } finally {
    db.close()
  }
})

test('the per-session cap is enforced', async () => {
  const db = openDatabase(':memory:')
  try {
    seedSession(db, 's1', ['今天聊了记忆系统的设计', '聊到很晚'])
    insertDiary(db, { sessionId: 's1', content: '已有的一篇' })
    insertDiary(db, { sessionId: 's1', content: '已有的两篇' })
    const engine = new DiaryEngine({ db, generate: async () => DIARY_REPLY, idleMs: 1000, maxPerSession: 2 })
    assert.equal(await engine.flush('s1'), false)
    assert.equal(countDiaries(db), 2)
    engine.dispose()
  } finally {
    db.close()
  }
})

test('a broken model call never throws', async () => {
  const db = openDatabase(':memory:')
  try {
    seedSession(db, 's1', ['今天聊了记忆系统的设计', '聊到很晚'])
    const engine = new DiaryEngine({
      db,
      generate: async () => {
        throw new Error('provider down')
      },
      idleMs: 1000,
      maxPerSession: 3,
    })
    assert.equal(await engine.flush('s1'), false)
    engine.dispose()
  } finally {
    db.close()
  }
})

test('too little conversation is skipped', async () => {
  const db = openDatabase(':memory:')
  try {
    seedSession(db, 's1', ['嗯'])
    const engine = new DiaryEngine({ db, generate: async () => DIARY_REPLY, idleMs: 1000, maxPerSession: 3 })
    assert.equal(await engine.flush('s1'), false)
    engine.dispose()
  } finally {
    db.close()
  }
})

test('a very long conversation produces a bounded prompt', async () => {
  const db = openDatabase(':memory:')
  try {
    const long = '很长的对话内容。'.repeat(400)
    seedSession(db, 's1', [long, long, long])
    let captured = ''
    const engine = new DiaryEngine({
      db,
      generate: async (prompt) => {
        captured = prompt
        return DIARY_REPLY
      },
      idleMs: 1000,
      maxPerSession: 3,
    })
    assert.equal(await engine.flush('s1'), true)
    assert.ok(captured.length < 4000, `prompt was ${captured.length} chars`)
    engine.dispose()
  } finally {
    db.close()
  }
})

test('catchUp does not judge the same quiet stretch twice', async () => {
  const db = openDatabase(':memory:')
  try {
    seedSession(db, 'old', ['今天聊了记忆系统的设计', '聊到很晚，我有点困了'])
    db.prepare("update sessions set last_active_at = datetime('now', '-2 hours') where id = 'old'").run()
    const engine = new DiaryEngine({
      db,
      generate: async () => DIARY_REPLY,
      idleMs: 30 * 60_000,
      maxPerSession: 3,
      now: () => new Date(),
    })
    assert.equal(await engine.catchUp(), 1)
    assert.equal(await engine.catchUp(), 0)
    assert.equal(countDiaries(db), 1)
    engine.dispose()
  } finally {
    db.close()
  }
})

test('new activity after a judgement re-arms it', async () => {
  const db = openDatabase(':memory:')
  try {
    seedSession(db, 'old', ['今天聊了记忆系统的设计', '聊到很晚，我有点困了'])
    db.prepare("update sessions set last_active_at = datetime('now', '-2 hours') where id = 'old'").run()
    const engine = new DiaryEngine({
      db,
      generate: async () => DIARY_REPLY,
      idleMs: 30 * 60_000,
      maxPerSession: 3,
      now: () => new Date(),
    })
    assert.equal(await engine.catchUp(), 1)
    // A later turn moved activity past the previous judgement mark, then went quiet.
    db.prepare(
      "update sessions set last_active_at = datetime('now', '-2 hours'), diary_judged_at = datetime('now', '-3 hours') where id = 'old'",
    ).run()
    assert.equal(await engine.catchUp(), 1)
    assert.equal(countDiaries(db), 2)
    engine.dispose()
  } finally {
    db.close()
  }
})

test('catchUp only judges sessions that went quiet', async () => {
  const db = openDatabase(':memory:')
  try {
    seedSession(db, 'old', ['今天聊了记忆系统的设计', '聊到很晚，我有点困了'])
    seedSession(db, 'fresh', ['今天聊了记忆系统的设计', '聊到很晚，我有点困了'])
    db.prepare("update sessions set last_active_at = datetime('now', '-2 hours') where id = 'old'").run()
    const engine = new DiaryEngine({
      db,
      generate: async () => DIARY_REPLY,
      idleMs: 30 * 60_000,
      maxPerSession: 3,
      now: () => new Date(),
    })
    assert.equal(await engine.catchUp(), 1)
    const rows = db.prepare('select session_id from diaries').all() as Array<{ session_id: string }>
    assert.deepEqual(
      rows.map((row) => row.session_id),
      ['old'],
    )
    engine.dispose()
  } finally {
    db.close()
  }
})
