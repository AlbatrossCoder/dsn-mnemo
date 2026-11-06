import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { getBond } from '../store/bond-store.js'
import { getSubjectLedger } from '../store/ledger-store.js'
import { touchSession } from '../store/message-store.js'
import { getMindState } from '../store/state-store.js'
import { createMindUpdateTool } from './mind-update.js'

function execFor(sessionId: string, messages: readonly unknown[] = []) {
  return { agent: { session: { id: sessionId, deriveMessages: () => messages } } } as never
}

test('mind_update writes state and a private bond, and marks the mind hint', async () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 's1', 1, { kind: 'dm', audienceId: 'alice' })
    const tool = createMindUpdateTool(db)
    const result = (await tool.execute(
      { mood: '有点困', energy: '低', unresolved: '还想着那口锅', notes: '爱开玩笑', temperature: 1.4 },
      execFor('s1'),
    )) as { state: boolean; bond: boolean; subject_id: string }
    assert.equal(result.state, true)
    assert.equal(result.bond, true)
    assert.equal(result.subject_id, 'alice')
    const state = getMindState(db, { kind: 'user', id: 'alice' })
    assert.equal(state?.mood, '有点困')
    assert.equal(state?.energy, '低')
    assert.equal(state?.unresolved, '还想着那口锅')
    const bond = getBond(db, { kind: 'user', id: 'alice' }, 'alice')
    assert.equal(bond?.notes, '爱开玩笑')
    assert.equal(bond?.temperature, 1)
    assert.ok(getSubjectLedger(db, { kind: 'user', id: 'alice' })?.mindWrittenAt)

    await tool.execute({ mood: '醒了' }, execFor('s1'))
    assert.equal(getMindState(db, { kind: 'user', id: 'alice' })?.energy, '低')
    assert.equal(getBond(db, { kind: 'user', id: 'alice' }, 'alice')?.notes, '爱开玩笑')
  } finally {
    db.close()
  }
})

test('mind_update in a group requires a peer and keeps an existing label when omitted', async () => {
  const db = openDatabase(':memory:')
  try {
    touchSession(db, 'g1', 1, { kind: 'group', audienceId: 'grp-1' })
    const tool = createMindUpdateTool(db)
    const exec = execFor('g1')
    await assert.rejects(tool.execute({ label: '小明' }, exec), /peer|号码/)
    await tool.execute({ peer_id: '10001', label: '小明', temperature: 0.2 }, exec)
    await tool.execute({ peer_id: '10001', notes: '话少' }, exec)
    const bond = getBond(db, { kind: 'group', id: 'grp-1' }, '10001')
    assert.equal(bond?.label, '小明')
    assert.equal(bond?.notes, '话少')
    assert.equal(bond?.temperature, 0.2)
    await assert.rejects(tool.execute({}, exec), /没有要更新/)
  } finally {
    db.close()
  }
})
