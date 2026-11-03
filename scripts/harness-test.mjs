/**
 * Local harness: mount dsh-tools' ToolRuntime in a bare Cordis context, then
 * mount this plugin and assert `mnemo_ping` reached the registry.
 *
 * This checks the registration path without booting the desktop app or
 * spending a model call. Run with the DSH-bundled Node:
 *   node scripts/harness-test.mjs
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as mnemo from '../lib/index.js'

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(mnemo, { dbPath: 'C:/tmp/mnemo-harness.db' })

const names = ctx.tools.schemas().map((schema) => schema.name)
assert.ok(names.includes('mnemo_ping'), `mnemo_ping missing from registry: ${names.join(', ')}`)

const definition = ctx.tools.get('mnemo_ping')
assert.ok(definition, 'mnemo_ping definition not retrievable')

const result = await definition.execute({}, {})
assert.deepEqual(result, {
  pong: true,
  version: '0.1.0',
  dbPath: 'C:/tmp/mnemo-harness.db',
})

console.log(`PASS registry tools: ${names.join(', ')}`)
console.log('PASS mnemo_ping execute ->', JSON.stringify(result))
