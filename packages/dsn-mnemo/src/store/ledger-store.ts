/**
 * Per-subject pending ledger.
 *
 * One row tracks diary prompting, diary settlement, mind prompting, and mind
 * settlement for a person or a group — across every DSH session of that subject.
 *
 * @module dsn-mnemo/store/ledger-store
 */
import type { DatabaseSync } from 'node:sqlite'
import type { SubjectRef } from './diary-store.js'

export interface SubjectLedger {
  readonly subjectKind: 'user' | 'group'
  readonly subjectId: string
  readonly diaryPromptedAt: string | null
  readonly diaryWrittenAt: string | null
  readonly mindPromptedAt: string | null
  readonly mindWrittenAt: string | null
  readonly updatedAt: string
}

interface LedgerRow {
  subject_kind: 'user' | 'group'
  subject_id: string
  diary_prompted_at: string | null
  diary_written_at: string | null
  mind_prompted_at: string | null
  mind_written_at: string | null
  updated_at: string
}

function toLedger(row: LedgerRow): SubjectLedger {
  return {
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    diaryPromptedAt: row.diary_prompted_at,
    diaryWrittenAt: row.diary_written_at,
    mindPromptedAt: row.mind_prompted_at,
    mindWrittenAt: row.mind_written_at,
    updatedAt: row.updated_at,
  }
}

export function getSubjectLedger(db: DatabaseSync, subject: SubjectRef): SubjectLedger | undefined {
  const row = db
    .prepare(
      `select subject_kind, subject_id, diary_prompted_at, diary_written_at,
              mind_prompted_at, mind_written_at, updated_at
         from subject_ledger where subject_kind = ? and subject_id = ?`,
    )
    .get(subject.kind, subject.id) as LedgerRow | undefined
  return row === undefined ? undefined : toLedger(row)
}

function touch(
  db: DatabaseSync,
  subject: SubjectRef,
  column: 'diary_prompted_at' | 'diary_written_at' | 'mind_prompted_at' | 'mind_written_at',
): void {
  db.prepare(
    `insert into subject_ledger(subject_kind, subject_id, ${column}, updated_at)
     values (?, ?, datetime('now'), datetime('now'))
     on conflict(subject_kind, subject_id) do update set
       ${column} = excluded.${column},
       updated_at = excluded.updated_at`,
  ).run(subject.kind, subject.id)
}

/** The hint was shown. This does not settle the diary stretch. */
export function markDiaryPrompted(db: DatabaseSync, subject: SubjectRef): void {
  touch(db, subject, 'diary_prompted_at')
}

/** A diary was actually written for this subject. */
export function markDiaryWritten(db: DatabaseSync, subject: SubjectRef): void {
  touch(db, subject, 'diary_written_at')
}

/** The mind hint was shown. */
export function markMindPrompted(db: DatabaseSync, subject: SubjectRef): void {
  touch(db, subject, 'mind_prompted_at')
}

/** `mind_update` actually ran. */
export function markMindWritten(db: DatabaseSync, subject: SubjectRef): void {
  touch(db, subject, 'mind_written_at')
}
