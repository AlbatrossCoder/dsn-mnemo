import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, inject, name } from './index.js'

test('plugin exports shape and default config', () => {
  assert.equal(name, 'dsn-whale-chat')
  assert.deepEqual(inject, ['tools', 'sessions', 'systemPrompt', 'agents'])
  const parsed = Config({})
  assert.equal(parsed.activePersona, 'little-whale')
  assert.equal(parsed.mischief, false)
  assert.equal(parsed.queen, false)
  assert.equal(parsed.kaomoji, false)
  assert.equal(parsed.groupTrigger, 'at')
})
