import assert from 'node:assert/strict'
import test from 'node:test'
import { ProactiveScheduler } from './proactive.js'
import type { Scheduler } from '../util/scheduler.js'

interface Job {
  handle: number
  fn: () => void
}

function fakeScheduler(): { scheduler: Scheduler; jobs: Job[]; run: (index: number) => void } {
  const jobs: Job[] = []
  let next = 1
  const scheduler: Scheduler = {
    set(callback, _delayMs) {
      const handle = next
      next += 1
      jobs.push({ handle, fn: callback })
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

test('fires once after the idle timer', () => {
  const { scheduler, run } = fakeScheduler()
  let fired = 0
  const proactive = new ProactiveScheduler({
    policy: { idleMs: 1000, maxPerDay: 3, quietHours: [0, 0] },
    onFire: () => {
      fired += 1
    },
    scheduler,
    now: () => Date.UTC(2026, 10, 4, 12, 0),
  })

  proactive.noteActivity('user:1')
  assert.equal(fired, 0)
  run(0)
  assert.equal(fired, 1)
})

test('noteActivity resets the timer instead of stacking fires', () => {
  const { scheduler, jobs, run } = fakeScheduler()
  let fired = 0
  const proactive = new ProactiveScheduler({
    policy: { idleMs: 1000, maxPerDay: 3, quietHours: [0, 0] },
    onFire: () => {
      fired += 1
    },
    scheduler,
    now: () => Date.UTC(2026, 10, 4, 12, 0),
  })

  proactive.noteActivity('user:1')
  proactive.noteActivity('user:1')
  assert.equal(jobs.length, 1)
  run(0)
  assert.equal(fired, 1)
})

test('never exceeds maxPerDay', () => {
  const { scheduler, run } = fakeScheduler()
  let fired = 0
  const proactive = new ProactiveScheduler({
    policy: { idleMs: 10, maxPerDay: 1, quietHours: [0, 0] },
    onFire: () => {
      fired += 1
    },
    scheduler,
    now: () => Date.UTC(2026, 10, 4, 12, 0),
  })

  proactive.noteActivity('user:1')
  run(0)
  proactive.noteActivity('user:1')
  run(0)
  assert.equal(fired, 1)
})

test('stays silent during quiet hours', () => {
  const { scheduler, run } = fakeScheduler()
  const base = Date.UTC(2026, 10, 4, 12, 0)
  const hour = new Date(base).getHours()
  let fired = 0
  const proactive = new ProactiveScheduler({
    policy: { idleMs: 10, maxPerDay: 3, quietHours: [hour, (hour + 1) % 24] },
    onFire: () => {
      fired += 1
    },
    scheduler,
    now: () => base,
  })

  proactive.noteActivity('user:1')
  run(0)
  assert.equal(fired, 0)
})
