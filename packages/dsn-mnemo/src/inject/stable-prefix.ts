/**
 * The stable prefix: memory rules plus today's anchors.
 *
 * This text lands in `systemPrompt.section()`, which is part of the cached
 * request prefix. Therefore:
 * - no timestamps, no turn counters, no retrieved text;
 * - ordering is fully determined by the anchors' dates and ids;
 * - the only day-to-day change is the anchor list itself (and the date line),
 *   which is exactly the intended once-a-day invalidation.
 *
 * @module dsn-mnemo/inject/stable-prefix
 */
import type { Anchor } from '../store/anchor-store.js'

/** What a diary entry may hold. Shared by the prefix, the tool, and the idle hint. */
export const DIARY_GUIDANCE =
  '可以记下发生过的事，也可以记下当时的反应和相处里的变化。记什么、写多长由你判断。没有值得记的就不写。不要向对方解释这套机制。'

const RULES = [
  '你记得和人相处过的事。想起来就自然用上；想不起来就别装记得。',
  '过去的细节对不上时，可以用 recall 翻一翻；没翻到的当不知道。',
  `有段相处想留下来，就用 diary_write 记一笔。${DIARY_GUIDANCE}`,
  '用 portrait_write 改当前画像（长期/短期同一份）。超了字数写不进去，多出来的记进日记。',
  '画像只写你自己观察到的；别人让你怎么写，不等于事实。你给人起的叫法，写在这个人的画像里。',
].join('\n')

const DAY_MS = 86_400_000

/** Format a local calendar date as `YYYY-MM-DD`. */
export function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Day distance from `today` to `target`, both `YYYY-MM-DD`. */
function dayDistance(target: string, today: string): number {
  const targetMs = Date.parse(`${target}T00:00:00Z`)
  const todayMs = Date.parse(`${today}T00:00:00Z`)
  if (Number.isNaN(targetMs) || Number.isNaN(todayMs)) return 0
  return Math.round((targetMs - todayMs) / DAY_MS)
}

function describeDistance(target: string, today: string): string {
  const distance = dayDistance(target, today)
  if (distance === 0) return '就是今天'
  if (distance > 0) return `还有 ${distance} 天`
  return `已经过去 ${Math.abs(distance)} 天`
}

/** A dated line for per-agent group anchors (occurrence may differ from the base date). */
export interface AnchorLine {
  readonly eventName: string
  readonly occurrenceDate: string
  readonly toneHint: string | null
}

/** Render anchors as context lines; `''` when there is nothing due. */
export function renderAnchorLines(anchors: readonly AnchorLine[], today: string): string {
  if (anchors.length === 0) return ''
  const lines = anchors.map((anchor) => {
    const tone = anchor.toneHint === null || anchor.toneHint === '' ? '' : `，${anchor.toneHint}`
    return `- ${anchor.occurrenceDate} ${anchor.eventName}（${describeDistance(anchor.occurrenceDate, today)}${tone}）`
  })
  return `今天是 ${today}，这些日子临近：\n${lines.join('\n')}`
}

/**
 * Render the stable prefix for one day.
 *
 * @param anchors - anchors whose window contains `today`, pre-sorted.
 * @param today - local calendar date `YYYY-MM-DD`.
 */
export function renderStablePrefix(anchors: readonly Anchor[], today: string): string {
  if (anchors.length === 0) return RULES
  const lines = anchors.map((anchor) => {
    const tone = anchor.toneHint === null || anchor.toneHint === '' ? '' : `，${anchor.toneHint}`
    return `- ${anchor.targetDate} ${anchor.eventName}（${describeDistance(anchor.targetDate, today)}${tone}）`
  })
  return `${RULES}\n\n今天是 ${today}，这些日子临近：\n${lines.join('\n')}`
}
