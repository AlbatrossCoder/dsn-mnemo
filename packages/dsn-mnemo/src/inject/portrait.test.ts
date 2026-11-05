import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { writePortrait } from '../store/portrait-store.js'
import { createPortraitText } from './portrait.js'

function qq(id: string, userId: string, text: string, groupId?: string) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'qq', userId, ...(groupId === undefined ? {} : { groupId }) },
  }
}

test('a private chat carries only that person', () => {
  const db = openDatabase(':memory:')
  try {
    writePortrait(db, { kind: 'user', id: '10001', part: 'long', content: '话少' })
    writePortrait(db, { kind: 'user', id: '10002', part: 'long', content: '别人' })
    const text = createPortraitText(db)({
      id: 's',
      deriveMessages: () => [qq('m', '10001', '在吗')],
    })
    assert.match(text, /话少/)
    assert.doesNotMatch(text, /别人/)
  } finally {
    db.close()
  }
})

test('a group carries the group, this turn’s senders, and a mentioned member', () => {
  const db = openDatabase(':memory:')
  try {
    writePortrait(db, { kind: 'group', id: '9', part: 'long', content: '夜猫子' })
    writePortrait(db, { kind: 'user', id: '2', part: 'long', content: '私聊秘密' })
    writePortrait(db, { kind: 'member', id: '9:2', part: 'short', content: '爱抬杠', label: '小明' })
    writePortrait(db, { kind: 'member', id: '9:3', part: 'short', content: '话很少', label: '阿花' })
    writePortrait(db, { kind: 'member', id: '9:4', part: 'short', content: '不该出现', label: '路人' })
    const provider = createPortraitText(db)
    const history = [
      { id: 'a', role: 'assistant', content: [{ type: 'text', text: '早' }] },
      qq('m', '2', '在吗', '9'),
    ]
    const quiet = provider({ id: 's', deriveMessages: () => history })
    assert.match(quiet, /夜猫子/)
    assert.match(quiet, /爱抬杠/)
    assert.doesNotMatch(quiet, /话很少/)
    assert.doesNotMatch(quiet, /不该出现/)
    assert.doesNotMatch(quiet, /私聊秘密/)

    const mentioned = provider({
      id: 's',
      deriveMessages: () => [...history, qq('m2', '2', '阿花呢', '9')],
    })
    assert.match(mentioned, /话很少/)
    assert.doesNotMatch(mentioned, /不该出现/)
  } finally {
    db.close()
  }
})
