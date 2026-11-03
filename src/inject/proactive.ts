/**
 * Proactive recall: surface relevant memory before the model answers.
 *
 * No keyword triggers: every turn builds a query from the **recent topic
 * segment** (see `window.ts`), retrieves memory points and diaries for the
 * current subject, and injects only hits above a relevance threshold. The
 * contribution is replaced every turn (never accumulated) and lives outside
 * the cached stable prefix.
 *
 * Rules:
 * 1. only a real human message ends the session's working context (local or QQ);
 * 2. the query is the recent topic segment, not a single message;
 * 3. hits below the threshold, or already shown within the cooldown, are dropped;
 * 4. results are capped by item count and token budget, and can be empty;
 * 5. group chats auto-inject `public` memories only; `private`/`secret` never.
 *
 * @module dsn-mnemo/inject/proactive
 */
import type { DatabaseSync } from 'node:sqlite'
import { searchDiaries } from '../store/diary-store.js'
import { searchPoints, type PointHit } from '../store/point-store.js'
import { sessionSubject } from '../store/message-store.js'
import { estimateTokens, rankDiaryHits, type RecallHit } from '../tools/recall.js'
import { buildProactiveQuery, type WindowMessage } from './window.js'

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
  /** Minimum association score for injection; defaults to 0.35. */
  readonly threshold?: number
  /** Turns before the same memory may be shown again; defaults to 10. */
  readonly cooldownTurns?: number
  readonly now?: () => Date
}

const MAX_LINE = 140
const DAY_MS = 86_400_000

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

/** The last real human message id, used to detect a new turn. */
function lastHumanId(messages: readonly WindowMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.role !== 'user') continue
    const kind = message.source?.kind
    if (kind !== 'user' && kind !== 'qq') continue
    const id = (message as { id?: unknown }).id
    return typeof id === 'string' ? id : String(index)
  }
  return undefined
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
  const cooldowns = new Map<string, Map<string, number>>()
  const turns = new Map<string, { lastId: string; index: number }>()
  const now = options.now ?? (() => new Date())
  const tokenBudget = options.tokenBudget ?? 600
  const threshold = options.threshold ?? 0.35
  const cooldownTurns = options.cooldownTurns ?? 10

  return (session) => {
    const messages = session.deriveMessages() as readonly WindowMessage[]
    const lastId = lastHumanId(messages)
    if (lastId === undefined) return ''
    const cached = memo.get(lastId)
    if (cached !== undefined) return cached

    const previous = turns.get(session.id)
    const turnIndex = previous === undefined || previous.lastId !== lastId ? (previous?.index ?? 0) + 1 : previous.index
    turns.set(session.id, { lastId, index: turnIndex })

    const subject = sessionSubject(db, session.id)
    const query = buildProactiveQuery(messages, { maxMessages: 16, maxChars: 300 })
    let text = ''
    if (query.tokens.length >= 2) {
      const at = now()
      const pointHits = searchPoints(db, query.text, subject, options.limit * 2, 'or')
      const diaryHits = searchDiaries(db, query.text, options.limit * 2, 'or', subject).filter(
        // Auto-injection in a group is public-only.
        (hit) => subject.kind !== 'group' || hit.visibility === 'public',
      )

      const cooldown = cooldowns.get(session.id) ?? new Map<string, number>()
      cooldowns.set(session.id, cooldown)

      const merged = [...rankPointHits(pointHits, at), ...rankDiaryHits(diaryHits, options.limit * 2, at)]
        .filter((hit) => hit.score >= threshold)
        .filter((hit) => {
          const key = `${hit.source}:${hit.id}`
          const shownAt = cooldown.get(key)
          return shownAt === undefined || turnIndex - shownAt >= cooldownTurns
        })
        .sort((a, b) => b.score - a.score)

      const capped = capHits(merged, options.limit, tokenBudget)
      if (capped.length > 0) {
        const next = new Map(cooldown)
        for (const hit of capped) next.set(`${hit.source}:${hit.id}`, turnIndex)
        cooldowns.set(session.id, next)
        text = renderProactive(capped)
      }
    }

    memo.set(lastId, text)
    if (memo.size > 200) {
      const oldest = memo.keys().next().value
      if (oldest !== undefined) memo.delete(oldest)
    }
    return text
  }
}
