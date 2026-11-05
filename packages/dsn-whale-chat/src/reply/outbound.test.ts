import assert from 'node:assert/strict'
import test from 'node:test'
import { OutboundQueue } from './outbound.js'

test('a typing pause longer than the gap is not extended', async () => {
  let now = 0
  const sent: number[] = []
  const queue = new OutboundQueue({
    dm: { minGapMs: 1000, maxPerMinute: 15, maxPerHour: 200 },
    group: { minGapMs: 2000, maxPerMinute: 8, maxPerHour: 80 },
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
  })
  queue.enqueue({
    kind: 'dm',
    delayMs: 1500,
    cancelled: () => false,
    run: () => sent.push(now),
  })
  queue.enqueue({
    kind: 'dm',
    delayMs: 1500,
    cancelled: () => false,
    run: () => sent.push(now),
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(sent, [1500, 3000])
})

test('a cancelled message is not sent', async () => {
  let now = 0
  let cancelled = false
  const sent: string[] = []
  const queue = new OutboundQueue({
    dm: { minGapMs: 0, maxPerMinute: 15, maxPerHour: 200 },
    group: { minGapMs: 0, maxPerMinute: 8, maxPerHour: 80 },
    now: () => now,
    sleep: async (ms) => {
      now += ms
      cancelled = true
    },
  })
  queue.enqueue({
    kind: 'group',
    delayMs: 100,
    cancelled: () => cancelled,
    run: () => sent.push('sent'),
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(sent, [])
})
