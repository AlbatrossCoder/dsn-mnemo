/**
 * Scheduler seam shared by the rate controller and the proactive timer, so
 * tests can drive both without real timers.
 */
export interface Scheduler {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

export const realScheduler: Scheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
