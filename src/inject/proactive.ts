/**
 * Proactive recall: surface relevant memory before the model answers.
 *
 * The contribution is replaced every turn (never accumulated) and lives
 * outside the cached stable prefix. Association, not a fixed top-N:
 *
 * 1. only a real human message can trigger a lookup (local prompt or QQ);
 * 2. the message is the query — memory points and diaries are ranked against
 *    it, and only hits above the threshold survive;
 * 3. results are capped by item count and token budget, and can be empty;
 * 4. an item already shown in this session is not shown again.
 *
 * @module dsn-mnemo/inject/proactive
 */
import type { DatabaseSync } from 'node:sqlite'
import { searchDiaries } from '../store/diary-store.js'
import { listRecentPoints, searchPoints, type PointHit } from '../store/point-store.js'
import { sessionSubject } from '../store/message-store.js'
import { estimateTokens, rankDiaryHits, type RecallHit } from '../tools/recall.js'

/** The slice of a Session this module needs. */
export interface ProactiveSession {
  readonly id: string
  deriveMessages(): readonly unknown[]
}

export interface ProactiveOptions {
  /** Maximum memory items per turn. */
  readonly limit: number
  /** Soft token budget for the rendered block; defaults to 600. */
  readonly tokenBudget?: number
  readonly now?: () => Date
}

const TIME_REFERENCE =
  /上次|之前|那天|还记得|记得|以前|去年|当年|那时候|当时|前几天|上周|上个月|前年|回忆|曾经|那次/
const EMOTION = /难过|开心|想你|孤独|害怕|生气|高兴|心疼|委屈|寂寞|焦虑|失落|幸福/
const RECENT_REFERENCE = /刚才|刚刚|最近|这会儿|这几天/
const DAY_MS = 86_400_000

/** Whether a user message is worth a memory lookup. */
export function isProactiveTrigger(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 4) return false
  return TIME_REFERENCE.test(trimmed) || EMOTION.test(trimmed) || RECENT_REFERENCE.test(trimmed)
}

interface MessageLike {
  readonly id?: unknown
  readonly role?: unknown
  readonly content?: unknown
  readonly source?: { readonly kind?: unknown }
}

interface HumanTurn {
  readonly id: string
  readonly text: string
}

/** Flatten text blocks only; images and tool calls are not search clues. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const value = block as { type?: unknown; text?: unknown }
    if (value.type === 'text' && typeof value.text === 'string') parts.push(value.text)
  }
  return parts.join('\n').trim()
}

/**
 * The last message the human actually typed.
 *
 * Injected context is also user-role, so the source kind is what separates a
 * real prompt (local or QQ) from a synthetic snapshot.
 */
export function lastHumanTurn(session: ProactiveSession): HumanTurn | undefined {
  const messages = session.deriveMessages()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as MessageLike | undefined
    if (message === undefined || message === null) continue
    if (message.role !== 'user') continue
    const kind = message.source?.kind
    if (kind !== 'user' && kind !== 'qq') continue
    const text = textOf(message.content)
    if (text.length === 0) continue
    return { id: typeof message.id === 'string' ? message.id : String(message.id), text }
  }
  return undefined
}

const MAX_LINE = 140

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= MAX_LINE ? flat : `${flat.slice(0, MAX_LINE)}…`
}

function recency(when: string, now: Date): number {
  const parsed = Date.parse(`${when.replace(' ', 'T')}Z`)
  if (Number.isNaN(parsed)) return 0
  return 1 / (1 + Math.max(0, (now.getTime() - parsed) / DAY_MS))
}

/** Normalise BM25 ranks into 0..1 where 1 is the best hit of the batch. */
function normalise(ranks: readonly number[]): (rank: number) => number {
  if (ranks.length === 0) return () => 0
  const best = Math.min(...ranks)
  const worst = Math.max(...ranks)
  if (best === worst) return () => 1
  return (rank) => (worst - rank) / (worst - best)
}

function rankPointHits(hits: readonly PointHit[], now: Date): RecallHit[] {
  if (hits.length === 0) return []
  const bm = normalise(hits.map((hit) => hit.rank))
  return hits.map((hit) => ({
    source: 'point' as const,
    id: hit.id,
    text: hit.text,
    score: 0.6 * bm(hit.rank) + 0.25 * hit.importance + 0.15 * recency(hit.createdAt, now),
    when: hit.createdAt,
  }))
}

/** Render hits as a clearly delimited, non-authoritative memory note. */
export function renderProactive(hits: readonly RecallHit[]): string {
  if (hits.length === 0) return ''
  const lines = hits.map(
    (hit) => `- ${hit.source === 'point' ? '[记忆点] ' : ''}${hit.when.slice(0, 10)} ${clip(hit.text)}`,
  )
  return [
    '以下是从长期记忆里浮现的内容，可能与当前对话有关（自然地使用，不要逐字复述，也不要声称这是用户刚说的）：',
    ...lines,
  ].join('\n')
}

/** Keep the best hits within both the item cap and the token budget. */
export function capHits(hits: readonly RecallHit[], limit: number, tokenBudget: number): RecallHit[] {
  const out: RecallHit[] = []
  let tokens = 0
  for (const hit of hits) {
    if (out.length >= limit) break
    const cost = estimateTokens(hit.text)
    if (out.length > 0 && tokens + cost > tokenBudget) break
    out.push(hit)
    tokens += cost
  }
  return out
}

/**
 * Build the per-agent context provider.
 *
 * Results are memoised per user message so several steps inside one turn see
 * exactly the same context text.
 */
export function createProactiveText(
  db: DatabaseSync,
  options: ProactiveOptions,
): (session: ProactiveSession) => string {
  const memo = new Map<string, string>()
  const shown = new Map<string, Set<string>>()
  const now = options.now ?? (() => new Date())
  const tokenBudget = options.tokenBudget ?? 600

  return (session) => {
    const turn = lastHumanTurn(session)
    if (turn === undefined) return ''
    const cached = memo.get(turn.id)
    if (cached !== undefined) return cached

    let text = ''
    if (isProactiveTrigger(turn.text)) {
      const subject = sessionSubject(db, session.id)
      const seen = shown.get(session.id) ?? new Set<string>()
      shown.set(session.id, seen)
      const at = now()
      const recent = RECENT_REFERENCE.test(turn.text)

      const pointHits = recent
        ? listRecentPoints(db, subject, options.limit * 2)
        : searchPoints(db, turn.text, subject, options.limit * 2, 'or')
      const diaryHits = searchDiaries(db, turn.text, options.limit * 2, 'or', subject).filter(
        (hit) => subject.kind !== 'group' || hit.visibility !== 'secret',
      )

      const merged = [...rankPointHits(pointHits, at), ...rankDiaryHits(diaryHits, options.limit * 2, at)]
        .sort((a, b) => b.score - a.score)
        .filter((hit) => !seen.has(`${hit.source}:${hit.id}`))

      const capped = capHits(merged, options.limit, tokenBudget)
      if (capped.length > 0) {
        for (const hit of capped) seen.add(`${hit.source}:${hit.id}`)
        text = renderProactive(capped)
      }
    }

    memo.set(turn.id, text)
    if (memo.size > 200) {
      const oldest = memo.keys().next().value
      if (oldest !== undefined) memo.delete(oldest)
    }
    return text
  }
}
