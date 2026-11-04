/**
 * Pending-diary hint: on the next message after a quiet stretch or a long
 * conversation, remind the running model that some content has not been turned
 * into a diary yet.
 *
 * The memory runtime never calls a model. It only injects this hint and lets
 * the model decide what (if anything) to write via `diary_write` — the way a
 * person might look back over a quiet afternoon and jot down what happened.
 *
 * @module dsn-mnemo/diary/pending
 */
import type { DatabaseSync } from 'node:sqlite'

/** The slice of a Session this module needs. */
export interface PendingSession {
  readonly id: string
  deriveMessages(): readonly unknown[]
}

export interface PendingOptions {
  /** Quiet time after the last completed turn before reminding. */
  readonly idleMs: number
  /** Turns since the last reminder that force one regardless of the gap. */
  readonly maxTurns: number
  /** Characters since the last reminder that force one regardless of the gap. */
  readonly maxChars: number
  readonly now?: () => Date
}

/** Too little to be worth a reminder; a bare 「嗯」 is not a conversation. */
const MIN_PROMPT_CHARS = 30

interface SessionRow {
  kind: string
  last_turn_end_at: string | null
  diary_judged_at: string | null
}

interface MessageRow {
  role: string
  content: string
  addressed: number
}

/** The last real human message id, used to memoise the hint within one turn. */
function lastHumanId(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; source?: { kind?: unknown }; id?: unknown } | undefined
    if (message === undefined || message.role !== 'user') continue
    const kind = message.source?.kind
    if (kind !== 'user' && kind !== 'qq') continue
    const id = message.id
    return typeof id === 'string' ? id : String(index)
  }
  return undefined
}

function parseUtc(value: string | null): number | null {
  if (value === null || value === '') return null
  const parsed = Date.parse(`${value.replace(' ', 'T')}Z`)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Build the per-agent pending-diary context provider. The result is memoised
 * per user message, so several steps inside one turn see the same text and the
 * `diary_judged_at` mark is advanced exactly once.
 */
export function createPendingDiaryText(
  db: DatabaseSync,
  options: PendingOptions,
): (session: PendingSession) => string {
  const memo = new Map<string, string>()
  const now = options.now ?? (() => new Date())

  return (session) => {
    const messages = session.deriveMessages()
    const marker = lastHumanId(messages)
    if (marker === undefined) return ''
    const cached = memo.get(marker)
    if (cached !== undefined) return cached

    const text = compute(db, session.id, options, now())
    memo.set(marker, text)
    if (memo.size > 200) {
      const oldest = memo.keys().next().value
      if (oldest !== undefined) memo.delete(oldest)
    }
    return text
  }
}

function compute(db: DatabaseSync, sessionId: string, options: PendingOptions, now: Date): string {
  const session = db
    .prepare('select kind, last_turn_end_at, diary_judged_at from sessions where id = ?')
    .get(sessionId) as SessionRow | undefined
  if (session === undefined) return ''
  const isGroup = session.kind === 'group'

  // Was there a quiet gap after the last completed turn? Without this the hint
  // would fire on every fresh message.
  const endedAt = parseUtc(session.last_turn_end_at)
  const idleElapsed = endedAt === null ? 0 : now.getTime() - endedAt

  const since = session.diary_judged_at ?? '1970-01-01 00:00:00'
  const messages = db
    .prepare(
      "select role, content, addressed from messages where session_id = ? and created_at > ? and role in ('user','assistant') order by id",
    )
    .all(sessionId, since) as unknown as MessageRow[]

  // Group chatter that never addressed the assistant is just L0 — no diary hint.
  const relevant = isGroup
    ? messages.filter((message) => message.role !== 'user' || message.addressed === 1)
    : messages

  const turns = relevant.filter((message) => message.role === 'user').length
  const chars = relevant.reduce((sum, message) => sum + message.content.length, 0)
  if (turns === 0 || chars < MIN_PROMPT_CHARS) return ''

  const idleMet = idleElapsed >= options.idleMs
  const lengthMet = turns >= options.maxTurns || chars >= options.maxChars
  if (!idleMet && !lengthMet) return ''

  // Mark before returning so the same stretch is not re-flagged every message.
  db.prepare("update sessions set diary_judged_at = datetime('now') where id = ?").run(sessionId)

  return `之前有一段对话（约 ${turns} 条消息）还没有沉淀成日记。请像写日记一样，把其中值得记住的内容用 diary_write 记下来（做了什么、聊了什么、做了什么决定都算，日常琐事也可以）；没有值得记的就忽略，不要向用户解释这套机制。`
}
