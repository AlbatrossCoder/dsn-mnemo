import assert from 'node:assert/strict'
import test from 'node:test'
import { countNeighborSignals, looksLikeNeighborWhale, neighborSceneNote } from './neighbors.js'

test('neighbor markers catch shared fish tropes', () => {
  assert.equal(looksLikeNeighborWhale('嫌贵别喂啊mer'), true)
  assert.equal(looksLikeNeighborWhale('本鱼不叫那个'), true)
  assert.equal(looksLikeNeighborWhale('今天天气不错'), false)
})

test('neighborSceneNote stays quiet until the echo is clear', () => {
  assert.equal(neighborSceneNote(['今天天气不错', '吃了吗']), '')
  assert.equal(countNeighborSignals(['守锅的是我', '饿三天不行', '随便聊聊']), 2)
  assert.match(neighborSceneNote(['守锅的是我', '换盆也行', '随便']), /别的鱼/)
})
