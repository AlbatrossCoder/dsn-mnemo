/**
 * Chat rate control: debounce bursts, merge them into one turn, and enforce
 * cooldown / per-minute / per-hour limits per conversation.
 *
 * Pure state machine with injectable clock and scheduler, so it is testable
 * without real timers.
 */

export interface RatePolicy {
  /** Wait this long after the last message before flushing. */
  readonly debounceMs: number
  /** Flush early once this many messages accumulate; 0 disables early flush. */
  readonly batchSize: number
  /** Minimum gap between two flushes. */
  readonly cooldownMs: number
  readonly maxPerMinute: number
  readonly maxPerHour: number
}

export interface Scheduler {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

export const realScheduler: Scheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface RateOptions {
  readonly policy: RatePolicy
  /** Called with the merged texts when a batch is admitted. */
  readonly onFlush: (key: string, texts: readonly string[]) => void
  readonly scheduler?: Scheduler
  readonly now?: () => number
}

interface Window {
  start: number
  count: number
}

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

export class RateController {
  private readonly pending = new Map<string, string[]>()
  private readonly timers = new Map<string, unknown>()
  private readonly lastFlushAt = new Map<string, number>()
  private readonly minute = new Map<string, Window>()
  private readonly hour = new Map<string, Window>()
  private readonly scheduler: Scheduler
  private readonly now: () => number

  constructor(private readonly options: RateOptions) {
    this.scheduler = options.scheduler ?? realScheduler
    this.now = options.now ?? Date.now
  }

  /** Accept one message; may flush immediately (batch) or arm the debounce. */
  offer(key: string, text: string): void {
    this.clearTimer(key)
    const list = this.pending.get(key) ?? []
    list.push(text)
    this.pending.set(key, list)
    if (this.options.policy.batchSize > 0 && list.length >= this.options.policy.batchSize) {
      this.flush(key)
      return
    }
    this.arm(key, this.options.policy.debounceMs)
  }

  /** Forget one conversation's pending work and timer. */
  cancel(key: string): void {
    this.clearTimer(key)
    this.pending.delete(key)
  }

  /** Forget every conversation's pending work and timer. */
  cancelAll(): void {
    for (const key of [...this.timers.keys()]) this.clearTimer(key)
    this.pending.clear()
  }

  private arm(key: string, delayMs: number): void {
    this.clearTimer(key)
    const handle = this.scheduler.set(() => {
      this.timers.delete(key)
      this.flush(key)
    }, Math.max(0, delayMs))
    this.timers.set(key, handle)
  }

  private flush(key: string): void {
    const texts = this.pending.get(key)
    if (texts === undefined || texts.length === 0) return
    const at = this.now()
    const last = this.lastFlushAt.get(key)
    // The first flush of a conversation is never held by the cooldown.
    const cooldownLeft = last === undefined ? 0 : this.options.policy.cooldownMs - (at - last)
    if (cooldownLeft > 0) {
      this.arm(key, cooldownLeft)
      return
    }
    if (!this.admit(key, at)) {
      this.arm(key, MINUTE_MS)
      return
    }
    this.pending.delete(key)
    this.lastFlushAt.set(key, at)
    this.options.onFlush(key, texts)
  }

  private admit(key: string, at: number): boolean {
    const minute = this.window(this.minute, key, at, MINUTE_MS)
    const hour = this.window(this.hour, key, at, HOUR_MS)
    if (minute.count >= this.options.policy.maxPerMinute) return false
    if (hour.count >= this.options.policy.maxPerHour) return false
    minute.count += 1
    hour.count += 1
    return true
  }

  private window(map: Map<string, Window>, key: string, at: number, span: number): Window {
    const current = map.get(key)
    if (current === undefined || at - current.start >= span) {
      const fresh: Window = { start: at, count: 0 }
      map.set(key, fresh)
      return fresh
    }
    return current
  }

  private clearTimer(key: string): void {
    const handle = this.timers.get(key)
    if (handle === undefined) return
    this.scheduler.clear(handle)
    this.timers.delete(key)
  }
}
