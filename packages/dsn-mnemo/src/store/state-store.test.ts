import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase, MEMORY_DB } from '../db/database.js'
import { getMindState, renderMindState, upsertMindState } from './state-store.js'

test('upsertMindState creates and updates a subject row', () => {
  const db = openDatabase(MEMORY_DB)
  const subject = { kind: 'user' as const, id: '10001' }
  upsertMindState(db, { subject, mood: '有点困', energy: '低' })
  const first = getMindState(db, subject)
  assert.equal(first?.mood, '有点困')
  assert.equal(first?.energy, '低')
  upsertMindState(db, { subject, unresolved: '还想着那口锅' })
  const second = getMindState(db, subject)
  assert.equal(second?.mood, '有点困')
  assert.equal(second?.unresolved, '还想着那口锅')
})

test('renderMindState stays quiet when empty', () => {
  assert.equal(renderMindState(undefined), '')
  const db = openDatabase(MEMORY_DB)
  const state = upsertMindState(db, { subject: { kind: 'group', id: '9' } })
  assert.equal(renderMindState(state), '')
  assert.match(renderMindState({ ...state, mood: '还行' }), /【此刻】心情：还行/)
})
