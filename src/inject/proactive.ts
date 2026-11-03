/**
 * Proactive recall: surface relevant diaries before the model answers.
 *
 * The result is contributed through `systemPrompt.context()` on the agent's
 * scoped context, so it is replaced every turn and never accumulates. Three
 * rules keep it from becoming noise:
 *
 * 1. only user messages with a temporal or emotional cue trigger a search;
 * 2. a diary already shown in this session is not shown again;
 * 3. an empty contribution renders as `''`, which DSH treats as "nothing".
 *
 * @module dsn-mnemo/inject/proactive
 */
import type { DatabaseSync } from 'node:sqlite'
import { searchDiaries } from '../store/diary-store.js'
import { rankDiaryHits, type RecallHit } from '../tools/recall.js'

/** The slice of a Session this module needs. */
export interface ProactiveSession {
  readonly id: string
  deriveMessages(): readonly unknown[]
}

export interface ProactiveOptions {
  /** Maximum diaries per turn. */
  readonly limit: number
  readonly now?: () => Date
}

const TIME_REFERENCE =
  /上次|之前|那天|还记得|记得|以前|去年|当年|那时候|当时|前几天|上周|上个月|前年|回忆|曾经|那次/
const EMOTION = /难过|开心|想你|孤独|害怕|生气|高兴|心疼|委屈|寂寞|焦虑|失落|幸福/

/** Whether a user message is worth a memory lookup. */
export function isProactiveTrigger(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 4) return false
  return TIME_REFERENCE.test(trimmed) || EMOTION.test(trimmed)
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
 * Injected context is also user-role, so `source.kind === 'user'` is what
 * separates a real prompt from a synthetic snapshot.
 */
export function lastHumanTurn(session: ProactiveSession): HumanTurn | undefined {
  const messages = session.deriveMessages()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as MessageLike | undefined
    if (message === undefined || message === null) continue
    if (message.role !== 'user') continue
    if (message.source?.kind !== 'user') continue
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

/** Render hits as a clearly delimited, non-authoritative memory note. */
export function renderProactive(hits: readonly RecallHit[]): string {
  if (hits.length === 0) return ''
  const lines = hits.map((hit) => `- ${hit.when.slice(0, 10)} ${clip(hit.text)}`)
  return [
    '以下是从长期记忆里浮现的内容，可能与当前对话有关（自然地使用，不要逐字复述，也不要声称这是用户刚说的）：',
    ...lines,
  ].join('\n')
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
  const shown = new Map<string, Set<number>>()
  const now = options.now ?? (() => new Date())

  return (session) => {
    const turn = lastHumanTurn(session)
    if (turn === undefined) return ''
    const cached = memo.get(turn.id)
    if (cached !== undefined) return cached

    let text = ''
    if (isProactiveTrigger(turn.text)) {
      const seen = shown.get(session.id) ?? new Set<number>()
      shown.set(session.id, seen)
      const hits = rankDiaryHits(searchDiaries(db, turn.text, options.limit * 2, 'or'), options.limit * 2, now())
        .filter((hit) => !seen.has(hit.id))
        .slice(0, options.limit)
      if (hits.length > 0) {
        for (const hit of hits) seen.add(hit.id)
        text = renderProactive(hits)
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
