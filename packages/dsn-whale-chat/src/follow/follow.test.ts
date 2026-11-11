import assert from 'node:assert/strict'
import test from 'node:test'
import { FollowBuffer } from './follow.js'
import type { Scheduler } from '../util/scheduler.js'

interface Job {
  handle: number
  fn: () => void
  delay: number
}

function fakeScheduler(): { scheduler: Scheduler; jobs: Job[]; run: (index: number) => void } {
  const jobs: Job[] = []
  let next = 1
  const scheduler: Scheduler = {
    set(callback, delay) {
      const handle = next
      next += 1
      jobs.push({ handle, fn: callback, delay })
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

test('a closed window ignores messages', () => {
  const { scheduler } = fakeScheduler()
  const follow = new FollowBuffer<number>({
    debounceMs: () => 100,
    isBusy: () => false,
    scheduler,
    onFlush: () => {},
  })
  assert.equal(follow.offer('g', 1), 'ignored')
})

test('after she speaks, a quiet pause flushes the batch together', () => {
  const { scheduler, jobs, run } = fakeScheduler()
  const flushed: number[][] = []
  const follow = new FollowBuffer<number>({
    debounceMs: () => 100,
    isBusy: () => false,
    scheduler,
    onFlush: (_key, messages) => flushed.push([...messages]),
  })
  follow.watch('g')
  assert.equal(follow.offer('g', 1), 'queued')
  assert.equal(follow.offer('g', 2), 'queued')
  assert.equal(jobs.length, 1)
  run(0)
  assert.deepEqual(flushed, [[1, 2]])
  assert.equal(follow.isWatching('g'), true)
})

test('the tenth line flushes immediately once she is already watching', () => {
  const { scheduler, jobs } = fakeScheduler()
  const flushed: number[][] = []
  const follow = new FollowBuffer<number>({
    limit: 3,
    debounceMs: () => 100,
    isBusy: () => false,
    scheduler,
    onFlush: (_key, messages) => flushed.push([...messages]),
  })
  follow.watch('g')
  follow.offer('g', 1)
  follow.offer('g', 2)
  assert.equal(jobs.length, 1)
  follow.offer('g', 3)
  assert.deepEqual(flushed, [[1, 2, 3]])
  assert.equal(follow.offer('g', 4), 'queued')
})

test('lines that arrive before she speaks wait, then go out together', () => {
  const { scheduler, jobs, run } = fakeScheduler()
  let busy = true
  const flushed: number[][] = []
  const follow = new FollowBuffer<number>({
    limit: 10,
    debounceMs: () => 100,
    isBusy: () => busy,
    scheduler,
    onFlush: (_key, messages) => flushed.push([...messages]),
  })
  follow.accept('g')
  follow.offer('g', 1)
  follow.offer('g', 2)
  run(0)
  assert.deepEqual(flushed, [])
  assert.equal(follow.blocksIdle('g'), true)
  busy = false
  follow.watch('g')
  follow.poke('g')
  // Held lines still honor debounce / backoff; poke only arms the timer.
  assert.deepEqual(flushed, [])
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0]?.delay, 100)
  run(0)
  assert.deepEqual(flushed, [[1, 2]])
})

test('bump slows a held batch that poke releases after a turn', () => {
  const { scheduler, jobs, run } = fakeScheduler()
  let busy = true
  const flushed: number[][] = []
  const follow = new FollowBuffer<number>({
    debounceMs: () => 100,
    isBusy: () => busy,
    scheduler,
    onFlush: (_key, messages) => flushed.push([...messages]),
  })
  follow.watch('g')
  follow.offer('g', 1)
  run(0) // due while busy → held
  assert.deepEqual(flushed, [])
  follow.bump('g')
  busy = false
  follow.poke('g')
  assert.deepEqual(flushed, [])
  assert.equal(jobs[jobs.length - 1]?.delay, 200)
  run(jobs.length - 1)
  assert.deepEqual(flushed, [[1]])
})

test('silence before she has ever spoken drops the lines', () => {
  const { scheduler } = fakeScheduler()
  const flushed: number[] = []
  const follow = new FollowBuffer<number>({
    debounceMs: () => 100,
    isBusy: () => false,
    scheduler,
    onFlush: (_key, messages) => flushed.push(messages.length),
  })
  follow.accept('g')
  follow.offer('g', 1)
  follow.release('g')
  follow.poke('g')
  assert.deepEqual(flushed, [])
  assert.equal(follow.isOpen('g'), false)
})

test('discard drops the batch and keeps the watch and the fade', () => {
  const { scheduler, jobs, run } = fakeScheduler()
  const flushed: number[][] = []
  const follow = new FollowBuffer<number>({
    debounceMs: () => 100,
    isBusy: () => false,
    scheduler,
    onFlush: (_key, messages) => flushed.push([...messages]),
  })
  follow.watch('g')
  follow.bump('g')
  follow.offer('g', 1)
  follow.discard('g')
  assert.equal(follow.isWatching('g'), true)
  assert.equal(follow.levelOf('g'), 1)
  assert.equal(jobs.length, 0)
  follow.offer('g', 2)
  run(0)
  assert.deepEqual(flushed, [[2]])
})

test('silence on a follow batch closes the window and drops what is left', () => {
  const { scheduler } = fakeScheduler()
  const follow = new FollowBuffer<number>({
    debounceMs: () => 100,
    isBusy: () => true,
    scheduler,
    onFlush: () => {},
  })
  follow.watch('g')
  follow.offer('g', 1)
  follow.close('g')
  assert.equal(follow.isWatching('g'), false)
  assert.equal(follow.blocksIdle('g'), false)
  assert.equal(follow.offer('g', 2), 'ignored')
})

test('each follow-up reply slows the next batch; a direct call resets it', () => {
  const { scheduler, jobs } = fakeScheduler()
  const follow = new FollowBuffer<number>({
    debounceMs: () => 100,
    isBusy: () => false,
    scheduler,
    onFlush: () => {},
  })
  follow.watch('g')
  follow.offer('g', 1)
  assert.equal(jobs[jobs.length - 1]?.delay, 100)
  follow.bump('g')
  follow.offer('g', 2)
  assert.equal(jobs[jobs.length - 1]?.delay, 200)
  follow.bump('g')
  follow.offer('g', 3)
  assert.equal(jobs[jobs.length - 1]?.delay, 400)
  follow.reset('g')
  follow.offer('g', 4)
  assert.equal(jobs[jobs.length - 1]?.delay, 100)
})
