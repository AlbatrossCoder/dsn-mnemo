import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, inject, isGroupAddressed, name } from './index.js'

test('plugin exports shape and default config', () => {
  assert.equal(name, 'dsn-whale-chat')
  assert.deepEqual(inject, ['tools', 'sessions', 'systemPrompt', 'agents', 'llm'])
  const parsed = Config({})
  assert.equal(parsed.persona.active, 'little-whale')
  assert.equal(parsed.persona.addressUser, '主人')
  assert.equal(parsed.owner.userId, '')
  assert.equal(parsed.owner.role, '主人')
  assert.equal(parsed.owner.claim, true)
  assert.equal(parsed.toggles.mischief, false)
  assert.equal(parsed.toggles.queen, false)
  assert.equal(parsed.toggles.kaomoji, false)
  assert.equal(parsed.toggles.troll, false)
  assert.equal(parsed.trigger.group, 'at')
  assert.equal(parsed.rate.debounceMs, 3000)
  assert.equal(parsed.groupRate.debounceMs, 5000)
  assert.equal(parsed.groupRate.batchSize, 0)
  assert.equal(parsed.replySplit.enabled, true)
  assert.equal(parsed.replySplit.platformMaxChars, 4500)
  assert.equal(parsed.proactive.private.enabled, true)
  assert.equal(parsed.proactive.group.enabled, false)
  assert.equal(parsed.randomInterject.enabled, true)
  assert.equal(parsed.randomInterject.windowMinutes, 10)
  assert.equal(parsed.randomInterject.maxPerWindow, 1)
  assert.deepEqual(parsed.schedule.quietHours, [23, 8])
})

test('group wake is only @ or the display name', () => {
  assert.equal(isGroupAddressed({ mentioned: true, text: '你好' }, '吨吨'), true)
  assert.equal(isGroupAddressed({ mentioned: false, text: '吨吨在吗' }, '吨吨'), true)
  assert.equal(isGroupAddressed({ mentioned: false, text: '小鲸鱼在吗' }, '吨吨'), false)
  assert.equal(isGroupAddressed({ mentioned: false, text: '喂' }, '吨吨'), false)
  assert.equal(isGroupAddressed({ mentioned: false, text: '大肥鱼' }, '吨吨'), false)
  assert.equal(isGroupAddressed({ mentioned: false, text: '小鲸鱼在吗' }, '小鲸鱼'), true)
})
