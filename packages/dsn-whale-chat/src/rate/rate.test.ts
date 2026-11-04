import assert from 'node:assert/strict'
import test from 'node:test'
import { RateController, type RatePolicy, type Scheduler } from './rate.js'

interface Job {
  handle: number
  fn: () => void
  ms: number
}

function fakeScheduler(): { scheduler: Scheduler; jobs: Job[]; run: (index: number) => void } {
  const jobs: Job[] = []
  let next = 1
  const scheduler: Scheduler = {
    set(callback, delayMs) {
      const handle = next
      next += 1
      jobs.push({ handle, fn: callback, ms: delayMs })
      return handle
    },
    clear(handle) {
      const index = jobs.findIndex((job) => job.handle === handle)
      if (index >= 0) jobs.splice(index, 1)
    },
  }
  const run = (index: number): void => {
    const job = jobs[index]
    if (job === undefined) return
    jobs.splice(index, 1)
    job.fn()
  }
  return { scheduler, jobs, run }
}

function policy(overrides: Partial<RatePolicy> = {}): RatePolicy {
  return { debounceMs: 500, batchSize: 0, cooldownMs: 0, maxPerMinute: 100, maxPerHour: 1000, ...overrides }
}

test('debounces a burst into one flush', () => {
  const { scheduler, jobs, run } = fakeScheduler()
  const flushes: Array<{ key: string; texts: readonly string[] }> = []
  let clock = 0
  const rate = new RateController({
    policy: policy({ debounceMs: 500 }),
    onFlush: (key, texts) => flushes.push({ key, texts }),
    scheduler,
    now: () => clock,
  })

  rate.offer('user:1', 'a')
  rate.offer('user:1', 'b')
  assert.equal(flushes.length, 0)
  assert.equal(jobs.length, 1) // the second offer replaced the timer

  clock = 500
  run(0)
  assert.deepEqual(flushes, [{ key: 'user:1', texts: ['a', 'b'] }])
})

test('flushes early when the batch size is reached', () => {
  const { scheduler } = fakeScheduler()
  const flushes: string[][] = []
  let clock = 0
  const rate = new RateController({
    policy: policy({ batchSize: 2 }),
    onFlush: (_key, texts) => flushes.push([...texts]),
    scheduler,
    now: () => clock,
  })

  rate.offer('g:1', 'a')
  rate.offer('g:1', 'b')
  assert.deepEqual(flushes, [['a', 'b']])
})

test('respects the cooldown between flushes', () => {
  const { scheduler, jobs, run } = fakeScheduler()
  const flushes: number[] = []
  let clock = 0
  const rate = new RateController({
    policy: policy({ debounceMs: 100, cooldownMs: 1000 }),
    onFlush: () => flushes.push(clock),
    scheduler,
    now: () => clock,
  })

  clock = 0
  rate.offer('user:1', 'first')
  run(0)
  assert.deepEqual(flushes, [0])

  clock = 200
  rate.offer('user:1', 'second')
  run(0) // debounce fires at 300, but cooldown says wait until 1000
  assert.deepEqual(flushes, [0])
  assert.ok(jobs.length > 0)

  // Run the rescheduled job after the cooldown.
  clock = 1200
  run(0)
  assert.deepEqual(flushes, [0, 1200])
})

test('enforces the per-minute cap', () => {
  const { scheduler, run } = fakeScheduler()
  let flushed = 0
  let clock = 0
  const rate = new RateController({
    policy: policy({ maxPerMinute: 1, maxPerHour: 1000 }),
    onFlush: () => {
      flushed += 1
    },
    scheduler,
    now: () => clock,
  })

  rate.offer('user:1', 'a')
  run(0)
  assert.equal(flushed, 1)

  clock = 1000
  rate.offer('user:1', 'b')
  run(0)
  assert.equal(flushed, 1) // capped; rescheduled instead of flushing

  clock = 61_000
  run(0) // window rolled over
  assert.equal(flushed, 2)
})
