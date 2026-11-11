/**
 * Extractive Episode fallback: when a diary hint was shown and ignored through
 * another quiet gap, file a short first-person note so the stretch settles.
 *
 * This is intentionally plain (no model call). The running model can still
 * `diary_update` later if the auto note is wrong.
 *
 * @module dsn-mnemo/diary/auto-consolidate
 */
import type { DatabaseSync } from 'node:sqlite'
import { resolveOwnerId } from '../memory/visibility.js'
import { insertDiary, type SubjectRef } from '../store/diary-store.js'
import { markDiaryWritten } from '../store/ledger-store.js'

export interface OwnerOptions {
  readonly ownerId?: string
  readonly statePath?: string
}

interface StretchMessage {
  role: string
  content: string
}

function clip(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** Build a short first-person episode from recent lines. */
export function buildAutoDiary(messages: readonly StretchMessage[]): string {
  const clips = messages.slice(-24).map((message) => {
    const who = message.role === 'assistant' ? '我' : '对方'
    return `${who}：${clip(message.content)}`
  })
  return `（自动整理）这段相处里大致是：\n${clips.join('\n')}`
}

export interface AutoConsolidateInput {
  readonly db: DatabaseSync
  readonly subject: SubjectRef
  readonly sessionId: string
  readonly messages: readonly StretchMessage[]
  readonly owner?: OwnerOptions
}

/** Persist one auto episode and settle the diary stretch. Returns the new id. */
export function writeAutoDiary(input: AutoConsolidateInput): number {
  const ownerId = resolveOwnerId(input.owner ?? { ownerId: '', statePath: '' })
  const visibility =
    input.subject.kind === 'group'
      ? 'public'
      : ownerId.length > 0 && input.subject.id === ownerId
        ? 'secret'
        : 'private'
  const id = insertDiary(input.db, {
    sessionId: input.sessionId,
    subjectKind: input.subject.kind,
    subjectId: input.subject.id,
    visibility,
    content: buildAutoDiary(input.messages),
    importance: 0.35,
    emotion: 0.4,
    typeTags: ['自动'],
  })
  markDiaryWritten(input.db, input.subject)
  return id
}
