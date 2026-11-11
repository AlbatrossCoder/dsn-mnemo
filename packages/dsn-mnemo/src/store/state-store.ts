/**
 * Mind State: short near-term condition for a subject (person or group scene).
 *
 * @module dsn-mnemo/store/state-store
 */
import type { DatabaseSync } from 'node:sqlite'
import type { SubjectRef } from './diary-store.js'

export interface MindState {
  readonly subjectKind: 'user' | 'group'
  readonly subjectId: string
  readonly mood: string
  readonly energy: string
  readonly unresolved: string
  readonly updatedAt: string
}

export interface MindStateInput {
  readonly subject: SubjectRef
  readonly mood?: string
  readonly energy?: string
  readonly unresolved?: string
}

/** Read the current state row, if any. */
export function getMindState(db: DatabaseSync, subject: SubjectRef): MindState | undefined {
  const row = db
    .prepare(
      `select subject_kind, subject_id, mood, energy, unresolved, updated_at
       from mind_states where subject_kind = ? and subject_id = ?`,
    )
    .get(subject.kind, subject.id) as
    | {
        subject_kind: 'user' | 'group'
        subject_id: string
        mood: string
        energy: string
        unresolved: string
        updated_at: string
      }
    | undefined
  if (row === undefined) return undefined
  return {
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    mood: row.mood,
    energy: row.energy,
    unresolved: row.unresolved,
    updatedAt: row.updated_at,
  }
}

/** Insert or rewrite the state for one subject. Empty fields clear that slot. */
export function upsertMindState(db: DatabaseSync, input: MindStateInput): MindState {
  const current = getMindState(db, input.subject)
  const mood = input.mood ?? current?.mood ?? ''
  const energy = input.energy ?? current?.energy ?? ''
  const unresolved = input.unresolved ?? current?.unresolved ?? ''
  db.prepare(
    `insert into mind_states(subject_kind, subject_id, mood, energy, unresolved, updated_at)
     values (?, ?, ?, ?, ?, datetime('now'))
     on conflict(subject_kind, subject_id) do update set
       mood = excluded.mood,
       energy = excluded.energy,
       unresolved = excluded.unresolved,
       updated_at = excluded.updated_at`,
  ).run(input.subject.kind, input.subject.id, mood, energy, unresolved)
  return getMindState(db, input.subject)!
}

/** Compact prompt line; empty when nothing worth saying. */
export function renderMindState(state: MindState | undefined): string {
  if (state === undefined) return ''
  const bits: string[] = []
  if (state.mood.trim().length > 0) bits.push(`心情：${state.mood.trim()}`)
  if (state.energy.trim().length > 0) bits.push(`精力：${state.energy.trim()}`)
  if (state.unresolved.trim().length > 0) bits.push(`还挂着：${state.unresolved.trim()}`)
  if (bits.length === 0) return ''
  return `【此刻】${bits.join('；')}。累、烦或没劲就少说、说半句；不想接下场也可以不接。`
}
