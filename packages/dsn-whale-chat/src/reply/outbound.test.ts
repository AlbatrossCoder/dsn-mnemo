import assert from 'node:assert/strict'
import test from 'node:test'
import { BURST_GAP_MS, OutboundQueue, burstSegmentIndex } from './outbound.js'

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

test('a close pair keeps a short gap and still counts toward the minute cap', async () => {
  let now = 0
  const sent: number[] = []
  const queue = new OutboundQueue({
    dm: { minGapMs: 1000, maxPerMinute: 2, maxPerHour: 200 },
    group: { minGapMs: 2000, maxPerMinute: 8, maxPerHour: 80 },
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
  })
  queue.enqueue({ kind: 'dm', delayMs: 700, cancelled: () => false, run: () => sent.push(now) })
  queue.enqueue({
    kind: 'dm',
    delayMs: 700,
    burst: true,
    burstGapMs: BURST_GAP_MS,
    cancelled: () => false,
    run: () => sent.push(now),
  })
  queue.enqueue({ kind: 'dm', delayMs: 0, cancelled: () => false, run: () => sent.push(now) })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(sent, [700, 1400, 60_700])
})

test('one reply has at most one close pair, and never on the first segment', () => {
  assert.equal(burstSegmentIndex(1, () => 0), -1)
  assert.equal(burstSegmentIndex(4, () => 0.2), -1)
  const values = [0, 0.5]
  assert.equal(
    burstSegmentIndex(4, () => values.shift() ?? 1),
    2,
  )
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
