import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAnyMatchQuery, buildMatchQuery, segment } from './segment.js'

test('segment spaces Chinese words and drops blank pieces', () => {
  const output = segment('今天和主人聊了记忆系统的设计')
  assert.ok(output.includes('记忆'), output)
  assert.ok(output.includes('主人'), output)
  assert.equal(output.trim(), output)
  assert.equal(output.includes('  '), false)
})

test('segment keeps Latin words intact', () => {
  assert.equal(segment('hello world'), 'hello world')
})

test('buildMatchQuery quotes every token', () => {
  assert.equal(buildMatchQuery('记忆系统'), '"记忆" "系统"')
})

test('buildMatchQuery keeps 2-character words', () => {
  assert.equal(buildMatchQuery('难过'), '"难过"')
})

test('buildMatchQuery emits only well-formed quoted terms', () => {
  const pattern = /^"[^"]*"(?: "[^"]*")*$/
  for (const input of ['他说"好"', 'a"b', '（记忆）', 'mixed DSH 插件']) {
    const query = buildMatchQuery(input)
    assert.ok(query !== null, `no query for ${input}`)
    assert.match(query, pattern, `malformed FTS query for ${input}: ${query}`)
  }
})

test('buildMatchQuery returns null for punctuation-only input', () => {
  assert.equal(buildMatchQuery('   '), null)
  assert.equal(buildMatchQuery('，。！'), null)
})

test('buildAnyMatchQuery joins terms with OR', () => {
  assert.equal(buildAnyMatchQuery('记忆系统'), '"记忆" OR "系统"')
  assert.equal(buildAnyMatchQuery('   '), null)
})
