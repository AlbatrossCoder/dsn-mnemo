import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase, MEMORY_DB } from '../db/database.js'
import { getBond, listBonds, renderBonds, upsertBond } from './bond-store.js'

test('upsertBond keeps omitted fields', () => {
  const db = openDatabase(MEMORY_DB)
  const subject = { kind: 'group' as const, id: '1109648974' }
  upsertBond(db, { subject, peerId: '84272166', label: '主人', notes: '听他的' })
  upsertBond(db, { subject, peerId: '84272166', temperature: 0.9 })
  const bond = getBond(db, subject, '84272166')
  assert.equal(bond?.label, '主人')
  assert.equal(bond?.notes, '听他的')
  assert.equal(bond?.temperature, 0.9)
})

test('renderBonds skips empty rows', () => {
  assert.equal(renderBonds([]), '')
  const db = openDatabase(MEMORY_DB)
  const subject = { kind: 'user' as const, id: '1' }
  upsertBond(db, { subject, peerId: '1', label: '你', notes: '爱开玩笑' })
  const text = renderBonds(listBonds(db, subject))
  assert.match(text, /【相处】/)
  assert.match(text, /你：爱开玩笑/)
})
