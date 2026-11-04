/**
 * Idle proactive speech: after a conversation goes quiet for a random while,
 * wake the agent once with a "you may speak, or stay silent" nudge.
 *
 * Rate-safe by construction: at most `maxPerDay` fires per conversation, and
 * nothing fires during quiet hours.
 */
import { realScheduler, type Scheduler } from '../util/scheduler.js'

export interface ProactivePolicy {
  /** Lower bound of the random idle delay. */
  readonly idleMinMs: number
  /** Upper bound of the random idle delay. */
  readonly idleMaxMs: number
  readonly maxPerDay: number
  /** Local-time `[startHour, endHour)` during which nothing fires. */
  readonly quietHours: readonly [number, number]
}

export interface ProactiveOptions {
  readonly policy: ProactivePolicy
  readonly onFire: (key: string) => void
  readonly scheduler?: Scheduler
  readonly now?: () => number
  readonly random?: () => number
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export class ProactiveScheduler {
  private readonly timers = new Map<string, unknown>()
  private readonly days = new Map<string, { day: string; count: number }>()
  private readonly scheduler: Scheduler
  private readonly now: () => number
  private readonly random: () => number

  constructor(private readonly options: ProactiveOptions) {
    this.scheduler = options.scheduler ?? realScheduler
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  /** Reset the idle timer for one conversation (call on every inbound message). */
  noteActivity(key: string): void {
    this.cancel(key)
    const { idleMinMs, idleMaxMs } = this.options.policy
    const span = Math.max(0, idleMaxMs - idleMinMs)
    const delay = idleMinMs + this.random() * span
    const handle = this.scheduler.set(() => {
      this.timers.delete(key)
      this.fire(key)
    }, Math.max(0, delay))
    this.timers.set(key, handle)
  }

  cancel(key: string): void {
    const handle = this.timers.get(key)
    if (handle === undefined) return
    this.scheduler.clear(handle)
    this.timers.delete(key)
  }

  cancelAll(): void {
    for (const key of [...this.timers.keys()]) this.cancel(key)
  }

  private fire(key: string): void {
    if (this.isQuiet()) return
    if (!this.admit(key)) return
    this.options.onFire(key)
  }

  private admit(key: string): boolean {
    const day = dayOf(this.now())
    const current = this.days.get(key)
    if (current === undefined || current.day !== day) {
      this.days.set(key, { day, count: 1 })
      return true
    }
    if (current.count >= this.options.policy.maxPerDay) return false
    current.count += 1
    return true
  }

  private isQuiet(): boolean {
    const [start, end] = this.options.policy.quietHours
    if (start === end) return false
    const hour = new Date(this.now()).getHours()
    return start < end ? hour >= start && hour < end : hour >= start || hour < end
  }
}
