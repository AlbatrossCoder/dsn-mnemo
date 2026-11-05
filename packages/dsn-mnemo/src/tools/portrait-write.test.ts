import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { readPortrait } from '../store/portrait-store.js'
import { createPortraitWriteTool } from './portrait-write.js'

function execFor(sessionId: string, messages: readonly unknown[] = []) {
  return { agent: { session: { id: sessionId, deriveMessages: () => messages } } } as never
}

function qq(userId: string, groupId?: string) {
  return {
    role: 'user',
    content: [{ type: 'text', text: '在吗' }],
    source: { kind: 'qq', userId, ...(groupId === undefined ? {} : { groupId }) },
  }
}

test('a private chat rewrites that person and rejects a group portrait', async () => {
  const db = openDatabase(':memory:')
  try {
    const tool = createPortraitWriteTool(db, { ownerId: '1', statePath: '/tmp/mnemo-portrait-missing.json' })
    const exec = execFor('s', [qq('10001')])
    await tool.execute({ target: 'person', part: 'long', content: '话少' }, exec)
    await tool.execute({ target: 'person', part: 'long', content: '后来话多了' }, exec)
    const row = readPortrait(db, 'user', '10001')
    assert.equal(row?.longText, '后来话多了')
    await assert.rejects(tool.execute({ target: 'group', part: 'short', content: '群' }, exec), /私聊里不写群/)
  } finally {
    db.close()
  }
})

test('a group writes the group and a member, not a private portrait', async () => {
  const db = openDatabase(':memory:')
  try {
    const tool = createPortraitWriteTool(db, { ownerId: '1', statePath: '/tmp/mnemo-portrait-missing.json' })
    const exec = execFor('s', [qq('5', '9')])
    await tool.execute({ target: 'group', part: 'short', content: '夜猫子多' }, exec)
    await tool.execute({ target: 'member', part: 'long', content: '爱抬杠', member_id: '5', label: '杠精' }, exec)
    assert.equal(readPortrait(db, 'group', '9')?.shortText, '夜猫子多')
    const member = readPortrait(db, 'member', '9:5')
    assert.equal(member?.longText, '爱抬杠')
    assert.equal(member?.label, '杠精')
    await assert.rejects(tool.execute({ target: 'person', part: 'long', content: '私聊' }, exec), /群里不写私聊/)
  } finally {
    db.close()
  }
})

test('over-long text is rejected and an owner gets the doubled limit', async () => {
  const db = openDatabase(':memory:')
  try {
    const tool = createPortraitWriteTool(db, { ownerId: '7', statePath: '/tmp/mnemo-portrait-missing.json' })
    const owner = execFor('s', [qq('7')])
    const other = execFor('s2', [qq('8')])
    await tool.execute({ target: 'person', part: 'long', content: '字'.repeat(240) }, owner)
    await assert.rejects(
      tool.execute({ target: 'person', part: 'long', content: '字'.repeat(241) }, owner),
      /超了字数上限/,
    )
    await assert.rejects(
      tool.execute({ target: 'person', part: 'long', content: '字'.repeat(121) }, other),
      /超了字数上限/,
    )
    assert.equal(readPortrait(db, 'user', '8'), undefined)
    assert.equal(Array.from(readPortrait(db, 'user', '7')?.longText ?? '').length, 240)
  } finally {
    db.close()
  }
})

test('an empty configured owner is read from the whale-chat state file', async () => {
  const db = openDatabase(':memory:')
  const dir = mkdtempSync(join(tmpdir(), 'mnemo-owner-'))
  const statePath = join(dir, 'whale-chat-state.json')
  writeFileSync(statePath, JSON.stringify({ ownerId: '7' }))
  try {
    const tool = createPortraitWriteTool(db, { ownerId: '', statePath })
    await tool.execute(
      { target: 'person', part: 'short', content: '字'.repeat(120) },
      execFor('s', [qq('7')]),
    )
    assert.equal(Array.from(readPortrait(db, 'user', '7')?.shortText ?? '').length, 120)
  } finally {
    db.close()
  }
})
