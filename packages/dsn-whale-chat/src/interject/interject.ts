/**
 * Random interjection gate for group chatter.
 *
 * Experimental and off by default: on every non-addressed group message there
 * is a small probability of joining in, but only after `minMessagesBetween`
 * and at most `maxPerWindow` per `windowMinutes`.
 */

export interface InterjectPolicy {
  readonly enabled: boolean
  readonly probability: number
  readonly minMessagesBetween: number
  readonly windowMinutes: number
  readonly maxPerWindow: number
}

export interface InterjectOptions {
  readonly now?: () => number
  readonly random?: () => number
}

/** Build a gate: call it for each non-addressed group message; `true` = join in. */
export function createInterjectGate(policy: InterjectPolicy, options: InterjectOptions = {}): () => boolean {
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const windowMs = Math.max(1, policy.windowMinutes) * 60_000
  let messages = 0
  let windowStart = 0
  let windowCount = 0

  return () => {
    if (!policy.enabled) return false
    messages += 1
    if (messages < policy.minMessagesBetween) return false
    if (random() >= policy.probability) return false
    const at = now()
    if (at - windowStart >= windowMs) {
      windowStart = at
      windowCount = 0
    }
    if (windowCount >= policy.maxPerWindow) return false
    windowCount += 1
    messages = 0
    return true
  }
}
