/** Small text helpers shared by the chat routing. */

/** True when `text` contains any configured name/keyword (case-insensitive). */
export function matchesAny(text: string, needles: readonly string[]): boolean {
  const haystack = text.toLowerCase()
  return needles.some((needle) => {
    const probe = needle.trim().toLowerCase()
    return probe.length > 0 && haystack.includes(probe)
  })
}
