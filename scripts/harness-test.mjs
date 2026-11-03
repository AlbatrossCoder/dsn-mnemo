/**
 * Integration harness: mount the real Cordis services (system prompt, tool
 * runtime, session store), mount this plugin, then drive a real Session with
 * surface events and assemble the system prompt. Verifies L0 capture, recall,
 * and the stable prefix without a model call or the desktop app.
 *
 *   node scripts/harness-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { openDatabase } from '../lib/db/database.js'
import { insertDiary } from '../lib/store/diary-store.js'
import * as mnemo from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'mnemo-harness-'))
const dbPath = join(dir, 'mnemo.db')

// Seed one diary before the plugin takes ownership of the file.
{
  const seed = openDatabase(dbPath)
  insertDiary(seed, { content: '和主人一起看了海，风很大，主人笑了很久', importance: 0.9 })
  seed.close()
}

const today = new Date()
const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
const isoDay = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

const userMessage = {
  id: 'msg-user',
  role: 'user',
  content: [{ type: 'text', text: '我们上次聊了记忆系统的设计' }],
  source: { kind: 'user' },
}

const assistantMessage = {
  turn: 1,
  step: 0,
  message: {
    id: 'msg-assistant',
    role: 'assistant',
    content: [{ type: 'text', text: '对，四层记忆加三种回忆行为' }],
    source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
  },
  stream: [],
}

const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(mnemo, { dbPath })

  const names = ctx.tools.schemas().map((schema) => schema.name)
  for (const expected of ['mnemo_ping', 'recall', 'anchor_upsert', 'diary_write', 'diary_update']) {
    assert.ok(names.includes(expected), `${expected} missing from registry: ${names.join(', ')}`)
  }

  const ping = ctx.tools.get('mnemo_ping')
  const pong = await ping.execute({}, {})
  assert.equal(pong.pong, true)
  assert.match(pong.version, /^\d+\.\d+\.\d+$/)
  assert.equal(pong.dbPath, dbPath)

  const recall = ctx.tools.get('recall')
  assert.deepEqual((await recall.execute({ query: '还不存在的记忆' }, {})).results, [])

  // Real Session: the recorder must see these events and persist them.
  const session = ctx.sessions.create()
  session.append('turn/start', { turn: 1 })
  session.append('user/message', userMessage, { surfaceOp: 'append' })
  session.append('assistant/message', assistantMessage, { surfaceOp: 'append' })

  const found = await recall.execute({ query: '记忆系统', scope: 'log' }, {})
  assert.ok(found.results.length >= 1, JSON.stringify(found))
  assert.match(found.results[0].text, /^\[user\] 我们上次聊了记忆系统的设计$/)

  // Stable prefix: rules are present, and an anchor inside the window shows up.
  const before = await ctx.systemPrompt.assemble()
  const rulesBefore = before.sections.find((section) => section.name === 'mnemo:rules')
  assert.ok(rulesBefore, 'mnemo:rules section missing')
  assert.match(rulesBefore.text, /长期记忆库/)
  assert.doesNotMatch(rulesBefore.text, /测试纪念日/)

  const anchor = ctx.tools.get('anchor_upsert')
  await anchor.execute({ event_name: '测试纪念日', target_date: isoDay(tomorrow), tone_hint: '轻一点提' }, {})

  const after = await ctx.systemPrompt.assemble()
  const rulesAfter = after.sections.find((section) => section.name === 'mnemo:rules')
  assert.match(rulesAfter.text, /测试纪念日/)

  const again = await ctx.systemPrompt.assemble()
  const rulesAgain = again.sections.find((section) => section.name === 'mnemo:rules')
  assert.equal(rulesAfter.text, rulesAgain.text, 'stable prefix changed within the same day')

  // Dynamic context: a fake agent drives `agent/created`, the plugin registers
  // a per-agent context that surfaces the diary for a triggered user message.
  const fakeSession = {
    id: 's-fake',
    deriveMessages: () => [
      {
        id: 'm-fake',
        role: 'user',
        content: [{ type: 'text', text: '你还记得上次看海吗' }],
        source: { kind: 'user' },
      },
    ],
  }
  await ctx.emit('agent/created', { agent: { session: fakeSession, ctx }, source: 'fresh' })

  const withRecall = await ctx.systemPrompt.assemble()
  const memoryContext = withRecall.contexts.find((entry) => entry.name === 'mnemo:recall')
  assert.ok(memoryContext, 'mnemo:recall context missing')
  assert.match(memoryContext.text, /看了海/)

  const stableAgain = await ctx.systemPrompt.assemble()
  const stableContext = stableAgain.contexts.find((entry) => entry.name === 'mnemo:recall')
  assert.equal(stableContext.text, memoryContext.text, 'dynamic context changed within one turn')

  console.log(`PASS registry tools: ${names.join(', ')}`)
  console.log('PASS session/event -> L0 -> recall:', JSON.stringify(found.results[0]))
  console.log('PASS stable prefix ->', JSON.stringify(rulesAfter.text.split('\n')[0]))
  console.log('PASS proactive context ->', JSON.stringify(memoryContext.text.split('\n')[1]))
} finally {
  await ctx.fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
}
