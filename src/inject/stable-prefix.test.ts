import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDate, renderStablePrefix } from './stable-prefix.js'
import type { Anchor } from '../store/anchor-store.js'

function anchor(overrides: Partial<Anchor>): Anchor {
  return {
    id: 1,
    eventName: '一起看海',
    targetDate: '2026-11-05',
    windowDays: null,
    toneHint: null,
    lastFiredOn: null,
    handledAt: null,
    subjectKind: 'user',
    subjectId: 'local',
    repeat: 'none',
    createdAt: '2026-11-01 00:00:00',
    ...overrides,
  }
}

test('formatDate uses the local calendar', () => {
  assert.equal(formatDate(new Date(2026, 10, 3, 23, 30)), '2026-11-03')
})

test('rules-only prefix is stable', () => {
  const first = renderStablePrefix([], '2026-11-03')
  const second = renderStablePrefix([], '2026-11-03')
  assert.equal(first, second)
  assert.match(first, /recall/)
  assert.match(first, /长期记忆库/)
})

test('same day and same anchors render byte-identical text', () => {
  const anchors = [anchor({}), anchor({ id: 2, eventName: '生日', targetDate: '2026-11-04' })]
  assert.equal(renderStablePrefix(anchors, '2026-11-03'), renderStablePrefix(anchors, '2026-11-03'))
})

test('prefix changes only when the day changes', () => {
  const anchors = [anchor({})]
  assert.notEqual(renderStablePrefix(anchors, '2026-11-03'), renderStablePrefix(anchors, '2026-11-04'))
})

test('anchor lines carry date, distance and tone hint', () => {
  const text = renderStablePrefix([anchor({ toneHint: '别提太多' })], '2026-11-03')
  assert.match(text, /2026-11-05 一起看海（还有 2 天，别提太多）/)
  assert.match(text, /今天是 2026-11-03/)
})

test('past anchors read as already passed', () => {
  const text = renderStablePrefix([anchor({ targetDate: '2026-11-01' })], '2026-11-03')
  assert.match(text, /已经过去 2 天/)
})
