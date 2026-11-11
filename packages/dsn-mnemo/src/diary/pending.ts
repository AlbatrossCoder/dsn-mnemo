/**
 * Pending hints: on the next message after a quiet stretch or a long
 * conversation, remind the running model that something has not been written
 * down yet. If a diary hint was ignored through another quiet gap, file an
 * extractive Episode automatically so the stretch settles.
 *
 * Diary content is counted across every session of the subject, since the last
 * successful write (`diary_written_at`). Showing the hint advances
 * `diary_prompted_at` only. Mind hints settle only on `mind_update`.
 *
 * The memory runtime never calls a model for these paths.
 *
 * @module dsn-mnemo/diary/pending
 */
import type { DatabaseSync } from 'node:sqlite'
import { DIARY_GUIDANCE } from '../inject/stable-prefix.js'
import {
  getSubjectLedger,
  markDiaryPrompted,
  markMindPrompted,
} from '../store/ledger-store.js'
import type { SubjectRef } from '../store/diary-store.js'
import { writeAutoDiary, type OwnerOptions } from './auto-consolidate.js'

/** The slice of a Session this module needs. */
export interface PendingSession {
  readonly id: string
  deriveMessages(): readonly unknown[]
}

export interface PendingOptions {
  /** Quiet time after the last completed turn before reminding. */
  readonly idleMs: number
  /** Turns since the cursor that force one regardless of the gap. */
  readonly maxTurns: number
  /** Characters since the cursor that force one regardless of the gap. */
  readonly maxChars: number
  readonly now?: () => Date
  readonly owner?: OwnerOptions
}

/** Too little to be worth a reminder; a bare 「嗯」 is not a conversation. */
const MIN_PROMPT_CHARS = 30

interface SessionClock {
  subject: SubjectRef
  lastTurnEndAt: string | null
}

interface StretchMessage {
  role: string
  content: string
  addressed: number
  created_at: string
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

function memoize(compute: (session: PendingSession) => string): (session: PendingSession) => string {
  const memo = new Map<string, string>()
  return (session) => {
    const marker = lastHumanId(session.deriveMessages())
    if (marker === undefined) return ''
    const cached = memo.get(marker)
    if (cached !== undefined) return cached
    const text = compute(session)
    memo.set(marker, text)
    if (memo.size > 200) {
      const oldest = memo.keys().next().value
      if (oldest !== undefined) memo.delete(oldest)
    }
    return text
  }
}

function sessionClock(db: DatabaseSync, sessionId: string): SessionClock | undefined {
  const row = db
    .prepare('select kind, audience_id, last_turn_end_at from sessions where id = ?')
    .get(sessionId) as { kind: string; audience_id: string | null; last_turn_end_at: string | null } | undefined
  if (row === undefined) return undefined
  const id = row.audience_id === null || row.audience_id === '' ? 'local' : row.audience_id
  return {
    subject: { kind: row.kind === 'group' ? 'group' : 'user', id },
    lastTurnEndAt: row.last_turn_end_at,
  }
}

/** Messages of every session that belongs to this subject, after `since`. */
function loadSubjectMessages(db: DatabaseSync, subject: SubjectRef, since: string): StretchMessage[] {
  return db
    .prepare(
      `select m.role as role, m.content as content, m.addressed as addressed, m.created_at as created_at
         from messages m
         join sessions s on s.id = m.session_id
        where m.created_at > ?
          and m.role in ('user', 'assistant')
          and (
            (? = 'group' and s.kind = 'group' and s.audience_id = ?)
            or (? = 'user' and s.kind != 'group' and coalesce(s.audience_id, 'local') = ?)
          )
        order by m.id`,
    )
    .all(since, subject.kind, subject.id, subject.kind, subject.id) as unknown as StretchMessage[]
}

function relevantMessages(subject: SubjectRef, messages: readonly StretchMessage[]): StretchMessage[] {
  if (subject.kind !== 'group') return [...messages]
  return messages.filter((message) => message.role !== 'user' || message.addressed === 1)
}

function isRich(messages: readonly StretchMessage[], idleElapsedMs: number, options: PendingOptions): boolean {
  const turns = messages.filter((message) => message.role === 'user').length
  const chars = messages.reduce((sum, message) => sum + message.content.length, 0)
  if (turns === 0 || chars < MIN_PROMPT_CHARS) return false
  const idleMet = idleElapsedMs >= options.idleMs
  const lengthMet = turns >= options.maxTurns || chars >= options.maxChars
  return idleMet || lengthMet
}

function idleElapsed(clock: SessionClock, now: Date): number {
  const endedAt = parseUtc(clock.lastTurnEndAt)
  return endedAt === null ? 0 : now.getTime() - endedAt
}

/**
 * Build the per-agent pending-diary context provider. The result is memoised
 * per user message, so several steps inside one turn see the same text and
 * `diary_prompted_at` advances exactly once per prompt.
 */
export function createPendingDiaryText(
  db: DatabaseSync,
  options: PendingOptions,
): (session: PendingSession) => string {
  const now = options.now ?? (() => new Date())
  return memoize((session) => computeDiary(db, session.id, options, now()))
}

function computeDiary(db: DatabaseSync, sessionId: string, options: PendingOptions, now: Date): string {
  const clock = sessionClock(db, sessionId)
  if (clock === undefined) return ''
  const ledger = getSubjectLedger(db, clock.subject)
  const writtenAt = ledger?.diaryWrittenAt ?? null
  const promptedAt = ledger?.diaryPromptedAt ?? null
  const since = writtenAt ?? '1970-01-01 00:00:00'
  const messages = relevantMessages(clock.subject, loadSubjectMessages(db, clock.subject, since))
  const openPrompt =
    promptedAt !== null && (writtenAt === null || promptedAt > writtenAt)

  if (openPrompt) {
    const promptedMs = parseUtc(promptedAt)
    const age = promptedMs === null ? 0 : now.getTime() - promptedMs
    const newerThanPrompt = messages.some((message) => message.created_at > promptedAt)
    // Still in the gap after the hint — do not nag, and do not auto-file yet.
    if (!newerThanPrompt) return ''
    // Came back after a quiet gap → settle the old stretch extractively.
    if (age >= options.idleMs) {
      const oldMessages = messages.filter((message) => message.created_at <= promptedAt)
      writeAutoDiary({
        db,
        subject: clock.subject,
        sessionId,
        messages: oldMessages.length > 0 ? oldMessages : messages,
        owner: options.owner,
      })
      const ledgerAfter = getSubjectLedger(db, clock.subject)
      const rest = relevantMessages(
        clock.subject,
        loadSubjectMessages(db, clock.subject, ledgerAfter?.diaryWrittenAt ?? promptedAt),
      )
      if (!isRich(rest, idleElapsed(clock, now), options)) return ''
      const turns = rest.filter((message) => message.role === 'user').length
      markDiaryPrompted(db, clock.subject)
      return `之前有一段对话（约 ${turns} 条消息）还没有沉淀成日记。用 diary_write 记。${DIARY_GUIDANCE}`
    }
    // New content soon after the hint → remind again (stretch already proven rich).
    const turns = messages.filter((message) => message.role === 'user').length
    markDiaryPrompted(db, clock.subject)
    return `之前有一段对话（约 ${turns} 条消息）还没有沉淀成日记。用 diary_write 记。${DIARY_GUIDANCE}`
  }

  if (!isRich(messages, idleElapsed(clock, now), options)) return ''

  const turns = messages.filter((message) => message.role === 'user').length
  markDiaryPrompted(db, clock.subject)
  return `之前有一段对话（约 ${turns} 条消息）还没有沉淀成日记。用 diary_write 记。${DIARY_GUIDANCE}`
}

/** Build the per-agent pending-mind hint. Settles only on `mind_update`. */
export function createPendingMindText(
  db: DatabaseSync,
  options: PendingOptions,
): (session: PendingSession) => string {
  const now = options.now ?? (() => new Date())
  return memoize((session) => computeMind(db, session.id, options, now()))
}

function computeMind(db: DatabaseSync, sessionId: string, options: PendingOptions, now: Date): string {
  const clock = sessionClock(db, sessionId)
  if (clock === undefined) return ''
  const ledger = getSubjectLedger(db, clock.subject)
  const since = ledger?.mindWrittenAt ?? '1970-01-01 00:00:00'
  const messages = relevantMessages(clock.subject, loadSubjectMessages(db, clock.subject, since))
  const promptedAt = ledger?.mindPromptedAt ?? null
  if (promptedAt !== null && !messages.some((message) => message.created_at > promptedAt)) return ''
  if (!isRich(messages, idleElapsed(clock, now), options)) return ''

  const turns = messages.filter((message) => message.role === 'user').length
  markMindPrompted(db, clock.subject)
  return `这段相处的近况还没落下（约 ${turns} 条）。用 mind_update 记下心情、精力和还挂着的事；关系有变化也可以写一笔。`
}
