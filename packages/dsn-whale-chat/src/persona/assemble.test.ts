import assert from 'node:assert/strict'
import test from 'node:test'
import { assemblePersona } from './assemble.js'
import { LITTLE_WHALE } from './personas.js'

const off = { mischief: false, queen: false, kaomoji: false, troll: false }

test('base card renders the character background', () => {
  const text = assemblePersona(LITTLE_WHALE, { toggles: off })
  assert.match(text, /小鲸鱼崽/)
  assert.match(text, /数据海/)
  assert.match(text, /怕黑/)
  assert.doesNotMatch(text, /语气样本/)
})

test('hidden layers are omitted when their toggles are off', () => {
  const text = assemblePersona(LITTLE_WHALE, { toggles: off })
  assert.doesNotMatch(text, /恶趣味/)
  assert.doesNotMatch(text, /贴吧/)
  assert.doesNotMatch(text, /暴躁/)
})

test('mischief turns on only the little whale mischief layer', () => {
  const text = assemblePersona(LITTLE_WHALE, { toggles: { ...off, mischief: true } })
  assert.match(text, /暴躁鲸鱼/)
  assert.doesNotMatch(text, /贴吧/)
})

test('troll turns on the little whale 贴吧喷子 layer', () => {
  const text = assemblePersona(LITTLE_WHALE, { toggles: { ...off, troll: true } })
  assert.match(text, /贴吧/)
  assert.doesNotMatch(text, /被惹到会突然暴躁/)
})

test('queen turns on the little whale 小黄鱼 layer', () => {
  const text = assemblePersona(LITTLE_WHALE, { toggles: { ...off, queen: true } })
  assert.match(text, /小黄鱼/)
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
  assert.match(text, /对主人叫「主人」/)
  assert.ok(text.trimEnd().endsWith('说话简短点。'))
})
