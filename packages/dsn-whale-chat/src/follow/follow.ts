/**
 * Messages she keeps an eye on after she has actually spoken in a group.
 *
 * They are not the inbound list. A batch is at most {@link FOLLOW_LIMIT}
 * lines, debounced, and only handed over once she has spoken. If she stays
 * quiet on that batch, the caller closes the window and the lines are dropped.
 */
import { realScheduler, type Scheduler } from '../util/scheduler.js'

export const FOLLOW_LIMIT = 10
/** At most this many slow-downs; the pause stops growing beyond it. */
export const FOLLOW_BACKOFF_MAX = 3

export interface FollowOptions<T> {
  readonly limit?: number
  readonly debounceMs: (key: string) => number
  /** A turn is already running, or the inbound list is about to start one. */
  readonly isBusy: (key: string) => boolean
  readonly onFlush: (key: string, messages: readonly T[]) => void
  readonly scheduler?: Scheduler
}

export class FollowBuffer<T> {
  private readonly waiting = new Map<string, T[]>()
  private readonly open = new Set<string>()
  private readonly sticky = new Set<string>()
  private readonly held = new Set<string>()
  private readonly timers = new Map<string, unknown>()
  /** How many follow-up replies in a row; each one slows the next batch. */
  private readonly levels = new Map<string, number>()
  private readonly scheduler: Scheduler
  private readonly limit: number

  constructor(private readonly options: FollowOptions<T>) {
    this.scheduler = options.scheduler ?? realScheduler
    this.limit = options.limit ?? FOLLOW_LIMIT
  }

  /** A follow-up reply happened: wait longer before the next batch. */
  bump(key: string): void {
    const level = this.levels.get(key) ?? 0
    this.levels.set(key, Math.min(FOLLOW_BACKOFF_MAX, level + 1))
  }

  /** She was called directly: the backoff starts over. */
  reset(key: string): void {
    this.levels.delete(key)
  }

  levelOf(key: string): number {
    return this.levels.get(key) ?? 0
  }

  /** Take messages for the turn that is running now. Dropped if she never speaks. */
  accept(key: string): void {
    this.open.add(key)
  }

  /** She spoke. Keep what already arrived and keep watching afterwards. */
  watch(key: string): void {
    this.open.add(key)
    this.sticky.add(key)
  }

  /** The turn ended without her speaking, and she was not already watching. */
  release(key: string): void {
    if (this.sticky.has(key)) return
    this.close(key)
  }

  /** The topic moved on. Drop anything she did not answer. */
  close(key: string): void {
    this.open.delete(key)
    this.sticky.delete(key)
    this.waiting.delete(key)
    this.held.delete(key)
    this.levels.delete(key)
    this.clearTimer(key)
  }

  isOpen(key: string): boolean {
    return this.open.has(key)
  }

  isWatching(key: string): boolean {
    return this.sticky.has(key)
  }

  /** True when a follow batch is waiting, so idle speech should not start. */
  blocksIdle(key: string): boolean {
    return this.held.has(key) || (this.waiting.get(key)?.length ?? 0) > 0
  }

  offer(key: string, message: T): 'queued' | 'ignored' {
    if (!this.open.has(key)) return 'ignored'
    const list = this.waiting.get(key) ?? []
    if (list.length >= this.limit) return 'ignored'
    list.push(message)
    this.waiting.set(key, list)
    if (list.length >= this.limit) {
      this.clearTimer(key)
      this.due(key)
      return 'queued'
    }
    // A newer line restarts the pause, even if an older pause already elapsed.
    this.held.delete(key)
    this.arm(key)
    return 'queued'
  }

  /**
   * A turn ended: if a batch was held, start (or restart) the backoff timer.
   * Do not flush immediately — otherwise follow-up slow-down never applies to
   * lines that arrived while she was busy.
   */
  poke(key: string): void {
    if (!this.held.has(key) || !this.sticky.has(key) || this.options.isBusy(key)) return
    if ((this.waiting.get(key)?.length ?? 0) === 0) {
      this.held.delete(key)
      return
    }
    this.arm(key)
  }

  cancelAll(): void {
    for (const key of [...this.timers.keys()]) this.clearTimer(key)
  }

  private arm(key: string): void {
    this.clearTimer(key)
    const base = Math.max(0, this.options.debounceMs(key))
    const level = this.levels.get(key) ?? 0
    // 1×, 2×, 4×, 8× … up to FOLLOW_BACKOFF_MAX.
    const ms = base * 2 ** level
    const handle = this.scheduler.set(() => this.due(key), ms)
    this.timers.set(key, handle)
  }

  private due(key: string): void {
    this.timers.delete(key)
    if (!this.open.has(key) || (this.waiting.get(key)?.length ?? 0) === 0) return
    if (!this.sticky.has(key) || this.options.isBusy(key)) {
      this.held.add(key)
      return
    }
    this.flush(key)
  }

  private flush(key: string): void {
    this.held.delete(key)
    this.clearTimer(key)
    const list = this.waiting.get(key)
    if (list === undefined || list.length === 0) return
    this.waiting.delete(key)
    this.options.onFlush(key, list)
  }

  private clearTimer(key: string): void {
    const handle = this.timers.get(key)
    if (handle === undefined) return
    this.scheduler.clear(handle)
    this.timers.delete(key)
  }
}
