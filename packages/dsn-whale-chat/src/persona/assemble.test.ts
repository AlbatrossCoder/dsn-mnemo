import assert from 'node:assert/strict'
import test from 'node:test'
import { assemblePersona } from './assemble.js'
import { BIG_WHALE, LITTLE_WHALE } from './personas.js'

const off = { mischief: false, queen: false, kaomoji: false }

test('hidden layer is omitted when its toggle is off', () => {
  const text = assemblePersona(LITTLE_WHALE, { toggles: off })
  assert.match(text, /小鲸鱼崽/)
  assert.doesNotMatch(text, /恶趣味/)
  assert.doesNotMatch(text, /脏话/)
})

test('mischief turns on the little whale hidden layer', () => {
  const text = assemblePersona(LITTLE_WHALE, { toggles: { ...off, mischief: true } })
  assert.match(text, /脏话/)
})

test('queen only turns on the big whale hidden layer', () => {
  const big = assemblePersona(BIG_WHALE, { toggles: { ...off, queen: true } })
  assert.match(big, /女王/)
  const little = assemblePersona(LITTLE_WHALE, { toggles: { ...off, queen: true } })
  assert.doesNotMatch(little, /女王/)
})

test('kaomoji off appends a no-kaomoji rule; on does not', () => {
  assert.match(assemblePersona(LITTLE_WHALE, { toggles: { ...off, kaomoji: false } }), /不要使用颜文字/)
  assert.doesNotMatch(assemblePersona(LITTLE_WHALE, { toggles: { ...off, kaomoji: true } }), /不要使用颜文字/)
})

test('address and custom are appended last', () => {
  const text = assemblePersona(LITTLE_WHALE, {
    toggles: { ...off, kaomoji: true },
    addressUser: '主人',
    custom: '说话简短点。',
  })
  assert.match(text, /叫用户「主人」/)
  assert.ok(text.trimEnd().endsWith('说话简短点。'))
})
