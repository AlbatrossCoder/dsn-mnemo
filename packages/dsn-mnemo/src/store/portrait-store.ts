/**
 * Current portraits. One row per subject, rewritten in place.
 *
 * Kinds are `user` (a private chat), `group`, and `member` (`groupId:userId`).
 */
import type { DatabaseSync } from 'node:sqlite'

export type PortraitKind = 'user' | 'group' | 'member'

export interface Portrait {
  readonly kind: PortraitKind
  readonly id: string
  readonly label: string
  readonly longText: string
  readonly shortText: string
  readonly updatedAt: string
}

export interface PortraitWrite {
  readonly kind: PortraitKind
  readonly id: string
  readonly part: 'long' | 'short'
  readonly content: string
  readonly label?: string
}

interface PortraitRow {
  subject_kind: string
  subject_id: string
  label: string
  long_text: string
  short_text: string
  updated_at: string
}

function toPortrait(row: PortraitRow): Portrait {
  return {
    kind: row.subject_kind as PortraitKind,
    id: row.subject_id,
    label: row.label,
    longText: row.long_text,
    shortText: row.short_text,
    updatedAt: row.updated_at,
  }
}

export function readPortrait(db: DatabaseSync, kind: PortraitKind, id: string): Portrait | undefined {
  const row = db
    .prepare(
      `select subject_kind, subject_id, label, long_text, short_text, updated_at
         from portraits where subject_kind = ? and subject_id = ?`,
    )
    .get(kind, id) as PortraitRow | undefined
  return row === undefined ? undefined : toPortrait(row)
}

/** Member portraits whose id starts with `groupId:`. */
export function listMemberPortraits(db: DatabaseSync, groupId: string): Portrait[] {
  const prefix = `${groupId}:`
  const rows = db
    .prepare(
      `select subject_kind, subject_id, label, long_text, short_text, updated_at
         from portraits
        where subject_kind = 'member' and substr(subject_id, 1, length(?)) = ?
        order by subject_id`,
    )
    .all(prefix, prefix) as unknown as PortraitRow[]
  return rows.map((row) => toPortrait(row))
}

/** Replace one part. An omitted label keeps the stored label. */
export function writePortrait(db: DatabaseSync, input: PortraitWrite): void {
  const existing = readPortrait(db, input.kind, input.id)
  const label = input.label === undefined ? (existing?.label ?? '') : input.label
  const longText = input.part === 'long' ? input.content : (existing?.longText ?? '')
  const shortText = input.part === 'short' ? input.content : (existing?.shortText ?? '')
  db.prepare(
    `insert into portraits(subject_kind, subject_id, label, long_text, short_text, updated_at)
     values (?, ?, ?, ?, ?, datetime('now'))
     on conflict(subject_kind, subject_id) do update set
       label = excluded.label,
       long_text = excluded.long_text,
       short_text = excluded.short_text,
       updated_at = excluded.updated_at`,
  ).run(input.kind, input.id, label, longText, shortText)
}

export function deletePortraitsForUser(db: DatabaseSync, userId: string): number {
  const suffix = `:${userId}`
  const result = db
    .prepare(
      `delete from portraits
        where (subject_kind = 'user' and subject_id = ?)
           or (subject_kind = 'member' and substr(subject_id, -length(?)) = ?)`,
    )
    .run(userId, suffix, suffix)
  return Number(result.changes)
}

export function deletePortraitsForGroup(db: DatabaseSync, groupId: string): number {
  const prefix = `${groupId}:`
  const result = db
    .prepare(
      `delete from portraits
        where (subject_kind = 'group' and subject_id = ?)
           or (subject_kind = 'member' and substr(subject_id, 1, length(?)) = ?)`,
    )
    .run(groupId, prefix, prefix)
  return Number(result.changes)
}
