/**
 * Integration harness: mount the real Cordis services (system prompt, tool
 * runtime, session store), mount this plugin, then drive a real Session with
 * surface events. Verifies the whole L0 path — session/event → recorder →
 * SQLite → recall — without a model call or the desktop app.
 *
 *   node scripts/harness-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as mnemo from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'mnemo-harness-'))
const dbPath = join(dir, 'mnemo.db')

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
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(mnemo, { dbPath })

  const names = ctx.tools.schemas().map((schema) => schema.name)
  for (const expected of ['mnemo_ping', 'recall']) {
    assert.ok(names.includes(expected), `${expected} missing from registry: ${names.join(', ')}`)
  }

  const ping = ctx.tools.get('mnemo_ping')
  assert.ok(ping, 'mnemo_ping definition not retrievable')
  const pong = await ping.execute({}, {})
  assert.equal(pong.pong, true)
  assert.match(pong.version, /^\d+\.\d+\.\d+$/)
  assert.equal(pong.dbPath, dbPath)

  const recall = ctx.tools.get('recall')
  assert.ok(recall, 'recall definition not retrievable')
  assert.deepEqual((await recall.execute({ query: '还不存在的记忆' }, {})).results, [])

  // Drive a real Session: the recorder must see these events and persist them.
  const session = ctx.sessions.create()
  session.append('turn/start', { turn: 1 })
  session.append('user/message', userMessage, { surfaceOp: 'append' })
  session.append('assistant/message', assistantMessage, { surfaceOp: 'append' })

  const found = await recall.execute({ query: '记忆系统', scope: 'log' }, {})
  assert.equal(found.results.length, 1, JSON.stringify(found))
  assert.match(found.results[0].text, /^\[user\] 我们上次聊了记忆系统的设计$/)

  const assistantHit = await recall.execute({ query: '四层记忆', scope: 'log' }, {})
  assert.equal(assistantHit.results.length, 1, JSON.stringify(assistantHit))

  console.log(`PASS registry tools: ${names.join(', ')}`)
  console.log('PASS mnemo_ping ->', JSON.stringify(pong))
  console.log('PASS session/event -> L0 -> recall:', JSON.stringify(found.results[0]))
} finally {
  await ctx.fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
}
