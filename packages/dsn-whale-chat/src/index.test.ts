import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, inject, name } from './index.js'

test('plugin exports shape and default config', () => {
  assert.equal(name, 'dsn-whale-chat')
  assert.deepEqual(inject, ['tools', 'sessions', 'systemPrompt', 'agents', 'llm'])
  const parsed = Config({})
  assert.equal(parsed.persona.active, 'little-whale')
  assert.equal(parsed.toggles.mischief, false)
  assert.equal(parsed.toggles.queen, false)
  assert.equal(parsed.toggles.kaomoji, false)
  assert.equal(parsed.toggles.troll, false)
  assert.equal(parsed.trigger.group, 'at')
  assert.deepEqual(parsed.schedule.quietHours, [23, 8])
})
