/**
 * Bounded "seen message id" set, so a reconnect replay cannot double-process.
 */
export function createDedupe(max = 1000): (id: string) => boolean {
  const seen = new Set<string>()
  const order: string[] = []
  return (id) => {
    if (seen.has(id)) return false
    seen.add(id)
    order.push(id)
    if (order.length > max) {
      const oldest = order.shift()
      if (oldest !== undefined) seen.delete(oldest)
    }
    return true
  }
}
