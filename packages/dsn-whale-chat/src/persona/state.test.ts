import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStateStore } from './state.js'

const defaults = {
  activeId: 'little-whale',
  name: '小鲸鱼',
  addressUser: '哥哥',
  custom: '',
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
