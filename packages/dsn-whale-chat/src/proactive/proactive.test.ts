import assert from 'node:assert/strict'
import test from 'node:test'
import { ProactiveScheduler } from './proactive.js'
import type { Scheduler } from '../util/scheduler.js'

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

const policy = { idleMinMs: 15 * 60_000, idleMaxMs: 30 * 60_000, maxPerDay: 3, quietHours: [0, 0] as const }

test('arms a random delay inside [min, max]', () => {
  const { scheduler, jobs } = fakeScheduler()
  const proactive = new ProactiveScheduler({
    policy,
    onFire: () => {},
    scheduler,
    now: () => Date.UTC(2026, 10, 4, 12, 0),
    random: () => 0.5,
  })
  proactive.noteActivity('group:1')
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0]?.ms, 22.5 * 60_000)
})

test('fires once after the idle timer', () => {
  const { scheduler, run } = fakeScheduler()
  let fired = 0
  const proactive = new ProactiveScheduler({
    policy,
    onFire: () => {
      fired += 1
    },
    scheduler,
    now: () => Date.UTC(2026, 10, 4, 12, 0),
    random: () => 0.5,
  })
  proactive.noteActivity('group:1')
  assert.equal(fired, 0)
  run(0)
  assert.equal(fired, 1)
})

test('noteActivity resets the timer instead of stacking fires', () => {
  const { scheduler, jobs, run } = fakeScheduler()
  let fired = 0
  const proactive = new ProactiveScheduler({
    policy,
    onFire: () => {
      fired += 1
    },
    scheduler,
    now: () => Date.UTC(2026, 10, 4, 12, 0),
    random: () => 0.5,
  })
  proactive.noteActivity('group:1')
  proactive.noteActivity('group:1')
  assert.equal(jobs.length, 1)
  run(0)
  assert.equal(fired, 1)
})

test('never exceeds maxPerDay', () => {
  const { scheduler, run } = fakeScheduler()
  let fired = 0
  const proactive = new ProactiveScheduler({
    policy: { ...policy, maxPerDay: 1, idleMinMs: 10, idleMaxMs: 10 },
    onFire: () => {
      fired += 1
    },
    scheduler,
    now: () => Date.UTC(2026, 10, 4, 12, 0),
    random: () => 0,
  })
  proactive.noteActivity('group:1')
  run(0)
  proactive.noteActivity('group:1')
  run(0)
  assert.equal(fired, 1)
})

test('stays silent during quiet hours', () => {
  const { scheduler, run } = fakeScheduler()
  const at = Date.UTC(2026, 10, 4, 12, 0)
  const hour = new Date(at).getHours()
  let fired = 0
  const proactive = new ProactiveScheduler({
    policy: { ...policy, idleMinMs: 10, idleMaxMs: 10, quietHours: [hour, (hour + 1) % 24] },
    onFire: () => {
      fired += 1
    },
    scheduler,
    now: () => at,
    random: () => 0,
  })
  proactive.noteActivity('group:1')
  run(0)
  assert.equal(fired, 0)
})
