/**
 * Random interjection gate for group chatter.
 *
 * Experimental and off by default: on every non-addressed group message there
 * is a small probability of joining in, but only after `minMessagesBetween`
 * and at most `maxPerHour`. Risk-heavy features stay conservative.
 */

export interface InterjectPolicy {
  readonly enabled: boolean
  readonly probability: number
  readonly minMessagesBetween: number
  readonly maxPerHour: number
}

export interface InterjectOptions {
  readonly now?: () => number
  readonly random?: () => number
}

const HOUR_MS = 3_600_000

/** Build a gate: call it for each non-addressed group message; `true` = join in. */
export function createInterjectGate(policy: InterjectPolicy, options: InterjectOptions = {}): () => boolean {
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  let messages = 0
  let windowStart = 0
  let windowCount = 0

  return () => {
    if (!policy.enabled) return false
    messages += 1
    if (messages < policy.minMessagesBetween) return false
    if (random() >= policy.probability) return false
    const at = now()
    if (at - windowStart >= HOUR_MS) {
      windowStart = at
      windowCount = 0
    }
    if (windowCount >= policy.maxPerHour) return false
    windowCount += 1
    messages = 0
    return true
  }
}
