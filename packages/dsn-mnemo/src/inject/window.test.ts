import assert from 'node:assert/strict'
import test from 'node:test'
import { buildProactiveQuery, recentEntries, topicSegment } from './window.js'

function message(role: 'user' | 'assistant', text: string, sourceKind = role === 'assistant' ? 'model' : 'user') {
  return { role, content: [{ type: 'text', text }], source: { kind: sourceKind } }
}

test('consecutive user messages merge into one burst', () => {
  const entries = recentEntries([
    message('user', '我们周末去吃火锅吧'),
    message('user', '就上次那家'),
    message('assistant', '好呀'),
  ])
  assert.equal(entries.length, 2)
  assert.match(entries[0]?.text ?? '', /周末/)
  assert.match(entries[0]?.text ?? '', /上次那家/)
})

test('the topic segment excludes earlier chitchat', () => {
  const query = buildProactiveQuery([
    message('user', '今天天气不错'),
    message('assistant', '是呀，适合出门'),
    message('user', '我们周末去吃火锅吧'),
    message('user', '就上次那家'),
  ])
  assert.match(query.text, /火锅/)
  assert.doesNotMatch(query.text, /天气/)
  assert.ok(query.tokens.length >= 2)
})

test('a fragment inherits the previous topic when it carries too little signal', () => {
  const query = buildProactiveQuery([
    message('user', '我们周末去吃火锅吧'),
    message('assistant', '好呀'),
    message('user', '就上次那家'),
  ])
  assert.match(query.text, /火锅/)
})

test('the query is bounded by the character budget', () => {
  const long = '记忆'.repeat(400)
  const query = buildProactiveQuery([message('user', long)], { maxChars: 300 })
  assert.ok(query.text.length <= 300)
})

test('injected contexts are not part of the window', () => {
  const entries = recentEntries([
    message('user', '真实提问', 'user'),
    message('user', 'time snapshot', 'time-context'),
    message('user', 'runtime snapshot', 'runtime-context'),
  ])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.text, '真实提问')
})

test('topicSegment returns an empty query for no messages', () => {
  assert.deepEqual(topicSegment([]), { text: '', tokens: [] })
})
