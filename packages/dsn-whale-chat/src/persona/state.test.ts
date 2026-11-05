import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configFingerprint, createStateStore } from './state.js'

const defaults = {
  activeId: 'little-whale',
  name: '小鲸鱼',
  addressUser: '哥哥',
  custom: '',
  ownerId: '',
  addressPending: false,
  toggles: { mischief: false, queen: false, kaomoji: false, troll: false },
}

test('state store defaults, update, reset and persistence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-chat-state-'))
  try {
    const path = join(dir, 'state.json')
    const store = createStateStore(path, defaults)
    assert.equal(store.get().addressUser, '哥哥')

    const updated = store.update({ addressUser: '主人', toggles: { troll: true } })
    assert.equal(updated.addressUser, '主人')
    assert.equal(updated.toggles.troll, true)
    assert.equal(updated.toggles.mischief, false)

    // A fresh store reads the persisted file.
    const reloaded = createStateStore(path, defaults)
    assert.equal(reloaded.get().addressUser, '主人')
    assert.equal(reloaded.get().toggles.troll, true)

    const reset = store.reset()
    assert.equal(reset.addressUser, '哥哥')
    assert.equal(reset.toggles.troll, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a changed config fingerprint replaces operator fields and keeps the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-chat-state-'))
  try {
    const path = join(dir, 'state.json')
    const first = configFingerprint(defaults)
    const store = createStateStore(path, defaults, first)
    store.update({ addressUser: '主人', custom: '保留', ownerId: '42' })

    const nextDefaults = { ...defaults, addressUser: '老板', ownerId: '99', toggles: { ...defaults.toggles } }
    const reloaded = createStateStore(path, nextDefaults, configFingerprint(nextDefaults))
    assert.equal(reloaded.get().addressUser, '老板')
    assert.equal(reloaded.get().ownerId, '99')
    assert.equal(reloaded.get().custom, '保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
