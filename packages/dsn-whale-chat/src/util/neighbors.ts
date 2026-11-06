/**
 * Heuristics for other whale-like bots in the same group.
 *
 * Shared tropes from the local multi-fish scene; used only to inject a light
 * "don't echo them" note — never as an answer template.
 *
 * @module dsn-whale-chat/util/neighbors
 */

const NEIGHBOR_MARKERS =
  /(?:\bmer\b|本鱼|饿三天|守锅|光缆皮|大肥鱼|小肥鱼|尾巴尖|换盆|泡汤|鱼粮|炫小鱼)/u

/** True when a line looks like another fish-bot's voice or shared trope. */
export function looksLikeNeighborWhale(text: string): boolean {
  const flat = text.trim()
  if (flat.length === 0) return false
  return NEIGHBOR_MARKERS.test(flat)
}

/** How many recent lines look neighbor-like. */
export function countNeighborSignals(lines: readonly string[]): number {
  let count = 0
  for (const line of lines) {
    if (looksLikeNeighborWhale(line)) count += 1
  }
  return count
}

/** Short scene note when the group is echoing other fish. */
export function neighborSceneNote(lines: readonly string[], threshold = 2): string {
  if (countNeighborSignals(lines) < threshold) return ''
  return '群里好像还有别的鱼在晃。用你自己的接法，别跟同一套梗和句式。'
}
