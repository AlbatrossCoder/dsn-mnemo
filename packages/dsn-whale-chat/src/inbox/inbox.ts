/**
 * One inbound list per conversation.
 *
 * While idle, messages debounce into a single turn and leave the list as
 * "being handled". Messages that arrive after that stay unhandled until the
 * turn ends. A full list drops new messages and keeps what is already there.
 */
import { realScheduler, type Scheduler } from '../util/scheduler.js'

export type QueueStatus = '正常' | '加急' | '堆积'

/** Status of the batch about to be handed to one turn. */
export function queueStatus(count: number): QueueStatus {
  if (count < 3) return '正常'
  if (count <= 5) return '加急'
  return '堆积'
}

export interface InboxOptions<T> {
  readonly debounceMs: (key: string) => number
  /** Optional early flush when this many messages piled up (0 = off). */
  readonly batchSize?: (key: string) => number
  /** Pause after a finished turn before the next batch is handed over. */
  readonly cooldownMs?: (key: string) => number
  /**
   * Another turn for this conversation is already running.
   * Queued messages stay put until `poke`.
   */
  readonly paused?: (key: string) => boolean
  readonly onFlush: (key: string, messages: readonly T[], status: QueueStatus) => void
  readonly max?: number
  readonly scheduler?: Scheduler
}

export class Inbox<T> {
  private readonly waiting = new Map<string, T[]>()
  private readonly busy = new Set<string>()
  private readonly held = new Set<string>()
  private readonly timers = new Map<string, unknown>()
  private readonly scheduler: Scheduler
  private readonly max: number

  constructor(private readonly options: InboxOptions<T>) {
    this.scheduler = options.scheduler ?? realScheduler
    this.max = options.max ?? 10
  }

  /** True while a turn is running or unhandled messages are still queued. */
  blocksIdle(key: string): boolean {
    return this.busy.has(key) || (this.waiting.get(key)?.length ?? 0) > 0
  }

  /** Accept one message, or ignore it when the list is already full. */
  offer(key: string, message: T): 'queued' | 'ignored' {
    const list = this.waiting.get(key) ?? []
    if (list.length >= this.max) return 'ignored'
    list.push(message)
    this.waiting.set(key, list)
    if (this.busy.has(key)) return 'queued'
    if (this.options.paused?.(key) === true) {
      this.held.add(key)
      this.clearTimer(key)
      return 'queued'
    }
    const batch = this.options.batchSize?.(key) ?? 0
    if (batch > 0 && list.length >= batch) {
      this.clearTimer(key)
      this.flush(key)
      return 'queued'
    }
    this.arm(key, this.options.debounceMs(key))
    return 'queued'
  }

  /** The current turn finished. A remaining list starts after the cooldown. */
  settle(key: string): void {
    this.busy.delete(key)
    const list = this.waiting.get(key)
    if (list === undefined || list.length === 0) return
    if (this.options.paused?.(key) === true) {
      this.held.add(key)
      return
    }
    const wait = Math.max(0, this.options.cooldownMs?.(key) ?? 0)
    if (wait === 0) {
      this.flush(key)
      return
    }
    this.arm(key, wait)
  }

  /** Flush a batch that was held because another turn was running. */
  poke(key: string): void {
    if (!this.held.has(key) || this.busy.has(key)) return
    if (this.options.paused?.(key) === true) return
    this.held.delete(key)
    this.flush(key)
  }

  /** Drop pending timers. Used when the plugin stops. */
  cancelAll(): void {
    for (const key of [...this.timers.keys()]) this.clearTimer(key)
  }

  private arm(key: string, ms: number): void {
    this.clearTimer(key)
    const handle = this.scheduler.set(() => {
      this.timers.delete(key)
      if (this.busy.has(key)) return
      if (this.options.paused?.(key) === true) {
        if ((this.waiting.get(key)?.length ?? 0) > 0) this.held.add(key)
        return
      }
      this.held.delete(key)
      this.flush(key)
    }, Math.max(0, ms))
    this.timers.set(key, handle)
  }

  private flush(key: string): void {
    if (this.busy.has(key)) return
    this.held.delete(key)
    const list = this.waiting.get(key)
    if (list === undefined || list.length === 0) return
    this.waiting.delete(key)
    this.clearTimer(key)
    this.busy.add(key)
    this.options.onFlush(key, list, queueStatus(list.length))
  }

  private clearTimer(key: string): void {
    const handle = this.timers.get(key)
    if (handle === undefined) return
    this.scheduler.clear(handle)
    this.timers.delete(key)
  }
}
