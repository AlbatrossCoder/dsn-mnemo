import assert from 'node:assert/strict'
import test from 'node:test'
import { Inbox, queueStatus } from './inbox.js'
import type { Scheduler } from '../util/scheduler.js'

interface Job {
  handle: number
  fn: () => void
}

function fakeScheduler(): { scheduler: Scheduler; jobs: Job[]; run: (index: number) => void } {
  const jobs: Job[] = []
  let next = 1
  const scheduler: Scheduler = {
    set(callback) {
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
  return {
    scheduler,
    jobs,
    run(index) {
      const job = jobs[index]
      if (job === undefined) return
      jobs.splice(index, 1)
      job.fn()
    },
  }
}

test('queue status follows the batch size', () => {
  assert.equal(queueStatus(1), '正常')
  assert.equal(queueStatus(2), '正常')
  assert.equal(queueStatus(3), '加急')
  assert.equal(queueStatus(5), '加急')
  assert.equal(queueStatus(6), '堆积')
})

test('an idle burst flushes together after the debounce', () => {
  const { scheduler, jobs, run } = fakeScheduler()
  const flushed: number[] = []
  const inbox = new Inbox<number>({
    debounceMs: () => 100,
    scheduler,
    onFlush: (_key, messages) => flushed.push(messages.length),
  })
  assert.equal(inbox.offer('a', 1), 'queued')
  assert.equal(inbox.offer('a', 2), 'queued')
  assert.equal(jobs.length, 1)
  run(0)
  assert.deepEqual(flushed, [2])
  assert.equal(inbox.blocksIdle('a'), true)
})

test('a full list ignores new messages and keeps the ones already queued', () => {
  const { scheduler, jobs, run } = fakeScheduler()
  const flushed: number[][] = []
  const inbox = new Inbox<number>({
    debounceMs: () => 100,
    max: 2,
    scheduler,
    onFlush: (_key, messages) => flushed.push([...messages]),
  })
  inbox.offer('a', 1)
  inbox.offer('a', 2)
  assert.equal(inbox.offer('a', 3), 'ignored')
  run(0)
  assert.deepEqual(flushed, [[1, 2]])
})

test('messages that arrive during a turn wait for the turn to finish', () => {
  const { scheduler, jobs, run } = fakeScheduler()
  const flushed: number[][] = []
  const inbox = new Inbox<number>({
    debounceMs: () => 100,
    scheduler,
    onFlush: (_key, messages) => flushed.push([...messages]),
  })
  inbox.offer('a', 1)
  run(0)
  assert.equal(inbox.offer('a', 2), 'queued')
  assert.equal(jobs.length, 0)
  inbox.settle('a')
  assert.deepEqual(flushed, [[1], [2]])
  assert.equal(inbox.blocksIdle('a'), true)
})

test('a paused list waits until poke', () => {
  const { scheduler, jobs } = fakeScheduler()
  let paused = true
  const flushed: number[][] = []
  const inbox = new Inbox<number>({
    debounceMs: () => 100,
    paused: () => paused,
    scheduler,
    onFlush: (_key, messages) => flushed.push([...messages]),
  })
  inbox.offer('a', 1)
  assert.equal(jobs.length, 0)
  inbox.poke('a')
  assert.deepEqual(flushed, [])
  paused = false
  inbox.poke('a')
  assert.deepEqual(flushed, [[1]])
})
