/**
 * One serial send queue.
 *
 * Each message waits out its own typing pause, and also the gap and the
 * per-minute / per-hour caps for its kind (dm or group). The pause is the
 * longest of those, not the sum, so a typing wait that is already longer than
 * the gap is not extended.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

export interface OutboundLimits {
  readonly minGapMs: number
  readonly maxPerMinute: number
  readonly maxPerHour: number
}

export interface OutboundJob {
  readonly kind: 'dm' | 'group'
  /** Typing pause for this one message. */
  readonly delayMs: number
  readonly cancelled: () => boolean
  /** Runs at the start of the pause. Failures must not throw. */
  readonly beforeWait?: () => void
  readonly run: () => void
}

export interface OutboundOptions {
  readonly dm: OutboundLimits
  readonly group: OutboundLimits
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

interface Stamp {
  kind: 'dm' | 'group'
  at: number
}

export class OutboundQueue {
  private tail: Promise<void> = Promise.resolve()
  private readonly lastAt = new Map<'dm' | 'group', number>()
  private stamps: Stamp[] = []
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: OutboundOptions) {
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  enqueue(job: OutboundJob): void {
    this.tail = this.tail.then(() => this.run(job)).catch(() => {
      // One failed send must not freeze later messages.
    })
  }

  private async run(job: OutboundJob): Promise<void> {
    if (job.cancelled()) return
    try {
      job.beforeWait?.()
    } catch {
      // Typing status is optional.
    }
    const ready = await this.waitReady(job)
    if (!ready || job.cancelled()) return
    job.run()
    const at = this.now()
    this.lastAt.set(job.kind, at)
    this.stamps.push({ kind: job.kind, at })
  }

  private async waitReady(job: OutboundJob): Promise<boolean> {
    let typing = Math.max(0, job.delayMs)
    while (!job.cancelled()) {
      const at = this.now()
      const pause = Math.max(typing, this.gapWait(job.kind, at), this.limitWait(job.kind, at))
      if (pause <= 0) return true
      await this.sleep(pause)
      typing = 0
    }
    return false
  }

  private limits(kind: 'dm' | 'group'): OutboundLimits {
    return kind === 'group' ? this.options.group : this.options.dm
  }

  private gapWait(kind: 'dm' | 'group', at: number): number {
    const last = this.lastAt.get(kind)
    if (last === undefined) return 0
    return Math.max(0, this.limits(kind).minGapMs - (at - last))
  }

  private limitWait(kind: 'dm' | 'group', at: number): number {
    this.stamps = this.stamps.filter((stamp) => at - stamp.at < HOUR_MS)
    const limits = this.limits(kind)
    const own = this.stamps.filter((stamp) => stamp.kind === kind)
    let wait = 0
    const minute = own.filter((stamp) => at - stamp.at < MINUTE_MS)
    if (minute.length >= limits.maxPerMinute) {
      const oldest = minute[0]
      if (oldest !== undefined) wait = Math.max(wait, MINUTE_MS - (at - oldest.at))
    }
    const hour = own.filter((stamp) => at - stamp.at < HOUR_MS)
    if (hour.length >= limits.maxPerHour) {
      const oldest = hour[0]
      if (oldest !== undefined) wait = Math.max(wait, HOUR_MS - (at - oldest.at))
    }
    return wait
  }
}
