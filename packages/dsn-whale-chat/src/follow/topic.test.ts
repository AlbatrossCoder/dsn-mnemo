import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTopic, topicRelation } from './topic.js'

const HOTPOT = '我们周末去吃火锅吧'

test('a shared word keeps the thread', () => {
  assert.equal(topicRelation(HOTPOT, '火锅几个人'), 'same')
})

test('a different subject is a new thread', () => {
  assert.equal(topicRelation(HOTPOT, '今天天气真好'), 'new')
})

test('a fragment stays on the current thread', () => {
  assert.equal(topicRelation(HOTPOT, '嗯'), 'thin')
  assert.equal(topicRelation(HOTPOT, '然后呢'), 'thin')
})

test('a declined thread drops more of itself and a fragment', () => {
  const state = { text: HOTPOT, declined: true }
  assert.equal(nextTopic(state, '火锅几个人').action, 'drop')
  assert.equal(nextTopic(state, '嗯').action, 'drop')
})

test('a new thread is looked at without forgetting that it is still a follow', () => {
  const look = nextTopic({ text: HOTPOT, declined: true }, '今天天气真好')
  assert.equal(look.action, 'look')
  if (look.action !== 'look') return
  assert.equal(look.relation, 'new')
  assert.equal(look.text, '今天天气真好')
})

test('staying on a thread keeps the earlier words', () => {
  const look = nextTopic({ text: HOTPOT, declined: false }, '火锅几个人')
  assert.equal(look.action, 'look')
  if (look.action !== 'look') return
  assert.equal(look.relation, 'same')
  assert.match(look.text, /火锅吧/)
  assert.match(look.text, /几个人/)
})

test('a fragment does not replace the thread', () => {
  const look = nextTopic({ text: HOTPOT, declined: false }, '嗯')
  assert.equal(look.action, 'look')
  if (look.action !== 'look') return
  assert.equal(look.relation, 'same')
  assert.equal(look.text, HOTPOT)
})
