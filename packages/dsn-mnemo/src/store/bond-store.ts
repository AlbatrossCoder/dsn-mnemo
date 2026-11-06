/**
 * Bond: relationship ledger keyed by conversation subject + peer.
 *
 * In a DM, `peer_id` is usually the same as `subject_id`. In a group,
 * `subject` is the group and `peer_id` is a member QQ.
 *
 * @module dsn-mnemo/store/bond-store
 */
import type { DatabaseSync } from 'node:sqlite'
import type { SubjectRef } from './diary-store.js'

export interface Bond {
  readonly subjectKind: 'user' | 'group'
  readonly subjectId: string
  readonly peerId: string
  readonly label: string
  readonly notes: string
  readonly temperature: number
  readonly updatedAt: string
}

export interface BondInput {
  readonly subject: SubjectRef
  readonly peerId: string
  readonly label?: string
  readonly notes?: string
  readonly temperature?: number
}

/** Read one bond row. */
export function getBond(db: DatabaseSync, subject: SubjectRef, peerId: string): Bond | undefined {
  const row = db
    .prepare(
      `select subject_kind, subject_id, peer_id, label, notes, temperature, updated_at
       from bonds where subject_kind = ? and subject_id = ? and peer_id = ?`,
    )
    .get(subject.kind, subject.id, peerId) as
    | {
        subject_kind: 'user' | 'group'
        subject_id: string
        peer_id: string
        label: string
        notes: string
        temperature: number
        updated_at: string
      }
    | undefined
  if (row === undefined) return undefined
  return {
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    peerId: row.peer_id,
    label: row.label,
    notes: row.notes,
    temperature: row.temperature,
    updatedAt: row.updated_at,
  }
}

/** Insert or rewrite a bond. Omitted fields keep the previous value. */
export function upsertBond(db: DatabaseSync, input: BondInput): Bond {
  const current = getBond(db, input.subject, input.peerId)
  const label = input.label ?? current?.label ?? ''
  const notes = input.notes ?? current?.notes ?? ''
  const temperature = input.temperature ?? current?.temperature ?? 0.5
  db.prepare(
    `insert into bonds(subject_kind, subject_id, peer_id, label, notes, temperature, updated_at)
     values (?, ?, ?, ?, ?, ?, datetime('now'))
     on conflict(subject_kind, subject_id, peer_id) do update set
       label = excluded.label,
       notes = excluded.notes,
       temperature = excluded.temperature,
       updated_at = excluded.updated_at`,
  ).run(input.subject.kind, input.subject.id, input.peerId, label, notes, temperature)
  return getBond(db, input.subject, input.peerId)!
}

/** Bonds for a subject, newest first. */
export function listBonds(db: DatabaseSync, subject: SubjectRef, limit = 8): Bond[] {
  const rows = db
    .prepare(
      `select subject_kind, subject_id, peer_id, label, notes, temperature, updated_at
       from bonds where subject_kind = ? and subject_id = ?
       order by updated_at desc limit ?`,
    )
    .all(subject.kind, subject.id, limit) as Array<{
    subject_kind: 'user' | 'group'
    subject_id: string
    peer_id: string
    label: string
    notes: string
    temperature: number
    updated_at: string
  }>
  return rows.map((row) => ({
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    peerId: row.peer_id,
    label: row.label,
    notes: row.notes,
    temperature: row.temperature,
    updatedAt: row.updated_at,
  }))
}

/** Compact prompt block for the current peer (and optional extras). */
export function renderBonds(bonds: readonly Bond[]): string {
  const usable = bonds.filter((bond) => bond.label.trim().length > 0 || bond.notes.trim().length > 0)
  if (usable.length === 0) return ''
  const lines = usable.map((bond) => {
    const name = bond.label.trim().length > 0 ? bond.label.trim() : bond.peerId
    const note = bond.notes.trim()
    return note.length > 0 ? `- ${name}：${note}` : `- ${name}`
  })
  return `【相处】\n${lines.join('\n')}`
}
