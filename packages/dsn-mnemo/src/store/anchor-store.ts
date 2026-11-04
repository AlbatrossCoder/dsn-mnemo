/**
 * L2 anchors: dates that should surface on their own.
 *
 * Anchors belong to a subject (`user:<id>` or `group:<id>`). A single anchor
 * may repeat (daily / weekly / monthly / yearly); the memory system only does
 * deterministic date expansion, never judgement.
 *
 * "Missed" means the date passed without the anchor ever being surfaced or
 * handled: recalling it later is then a real miss, not just a memory.
 *
 * @module dsn-mnemo/store/anchor-store
 */
import type { DatabaseSync } from 'node:sqlite'
import type { SubjectRef } from './diary-store.js'

export type Repeat = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'

export interface AnchorInput {
  readonly eventName: string
  /** Local calendar date, `YYYY-MM-DD`. */
  readonly targetDate: string
  readonly subject: SubjectRef
  /** ± days around the target date; `null`/absent means the config default. */
  readonly windowDays?: number | null
  readonly toneHint?: string | null
  readonly repeat?: Repeat
}

export interface Anchor {
  readonly id: number
  readonly eventName: string
  readonly targetDate: string
  readonly windowDays: number | null
  readonly toneHint: string | null
  readonly lastFiredOn: string | null
  readonly handledAt: string | null
  readonly subjectKind: string
  readonly subjectId: string
  readonly repeat: Repeat
  readonly createdAt: string
}

/** An anchor together with the occurrence that is due on the queried day. */
export interface DueAnchor extends Anchor {
  readonly occurrenceDate: string
}

interface AnchorRow {
  id: number
  event_name: string
  target_date: string
  window_days: number | null
  tone_hint: string | null
  last_fired_on: string | null
  handled_at: string | null
  subject_kind: string | null
  subject_id: string | null
  repeat: string
  created_at: string
}

function toAnchor(row: AnchorRow): Anchor {
  return {
    id: row.id,
    eventName: row.event_name,
    targetDate: row.target_date,
    windowDays: row.window_days,
    toneHint: row.tone_hint,
    lastFiredOn: row.last_fired_on,
    handledAt: row.handled_at,
    subjectKind: row.subject_kind ?? 'user',
    subjectId: row.subject_id ?? 'local',
    repeat: row.repeat as Repeat,
    createdAt: row.created_at,
  }
}

/** Insert an anchor, or update the existing one with the same subject/name/date. */
export function upsertAnchor(db: DatabaseSync, input: AnchorInput): number {
  const existing = db
    .prepare(
      'select id from anchors where subject_kind = ? and subject_id = ? and event_name = ? and target_date = ?',
    )
    .get(input.subject.kind, input.subject.id, input.eventName, input.targetDate) as { id: number } | undefined

  if (existing !== undefined) {
    db.prepare('update anchors set window_days = ?, tone_hint = ?, repeat = ? where id = ?').run(
      input.windowDays ?? null,
      input.toneHint ?? null,
      input.repeat ?? 'none',
      existing.id,
    )
    return existing.id
  }

  const result = db
    .prepare(
      `insert into anchors(event_name, target_date, window_days, tone_hint, repeat, subject_kind, subject_id)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.eventName,
      input.targetDate,
      input.windowDays ?? null,
      input.toneHint ?? null,
      input.repeat ?? 'none',
      input.subject.kind,
      input.subject.id,
    )
  return Number(result.lastInsertRowid)
}

const DAY_MS = 86_400_000

function parseDate(value: string): Date {
  const [year, month, day] = value.split('-').map((part) => Number(part))
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1))
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS)
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / DAY_MS)
}

/** Candidate occurrence dates near `today` for a repeating anchor (clamped). */
function candidatesNear(anchor: Anchor, today: Date): Date[] {
  const target = parseDate(anchor.targetDate)
  switch (anchor.repeat) {
    case 'daily':
      return [today]
    case 'weekly': {
      const wanted = target.getUTCDay()
      const delta = (wanted - today.getUTCDay() + 7) % 7
      return [addDays(today, delta - 7), addDays(today, delta), addDays(today, delta + 7)]
    }
    case 'monthly': {
      const day = target.getUTCDate()
      const candidates: Date[] = []
      for (const offset of [-1, 0, 1]) {
        const base = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + offset, 1))
        const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate()
        candidates.push(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), Math.min(day, lastDay))))
      }
      return candidates
    }
    case 'yearly': {
      const month = target.getUTCMonth()
      const day = target.getUTCDate()
      const candidates: Date[] = []
      for (const offset of [-1, 0, 1]) {
        const year = today.getUTCFullYear() + offset
        const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
        candidates.push(new Date(Date.UTC(year, month, Math.min(day, lastDay))))
      }
      return candidates
    }
    default:
      return [target]
  }
}

/** Anchors whose window contains `today`, earliest occurrence first. */
export function anchorsInWindow(
  db: DatabaseSync,
  subject: SubjectRef,
  today: string,
  defaultWindowDays: number,
): DueAnchor[] {
  const rows = db
    .prepare(
      `select id, event_name, target_date, window_days, tone_hint, last_fired_on, handled_at,
              subject_kind, subject_id, repeat, created_at
         from anchors
        where subject_kind = ? and subject_id = ?`,
    )
    .all(subject.kind, subject.id) as unknown as AnchorRow[]

  const todayDate = parseDate(today)
  const due: DueAnchor[] = []
  for (const row of rows) {
    const anchor = toAnchor(row)
    const window = anchor.windowDays ?? defaultWindowDays
    const inWindow = candidatesNear(anchor, todayDate)
      .map((date) => ({ date, distance: Math.abs(daysBetween(date, todayDate)) }))
      .filter((candidate) => candidate.distance <= window)
    // Prefer the next occurrence: a weekly game night should announce the
    // upcoming Saturday even when last Saturday is technically closer.
    const upcoming = inWindow
      .filter((candidate) => candidate.date.getTime() >= todayDate.getTime())
      .sort((a, b) => a.distance - b.distance)
    const chosen = upcoming[0] ?? inWindow.sort((a, b) => a.distance - b.distance)[0]
    if (chosen !== undefined) due.push({ ...anchor, occurrenceDate: formatDate(chosen.date) })
  }
  return due.sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate) || a.id - b.id)
}

/**
 * Anchors whose date passed without being surfaced or handled.
 *
 * Only non-repeating anchors are reported: for a recurring event the next
 * occurrence simply comes around again, so "missed" is not meaningful.
 */
export function missedAnchors(
  db: DatabaseSync,
  subject: SubjectRef,
  today: string,
  defaultWindowDays: number,
  lookbackDays = 30,
): Anchor[] {
  const todayDate = parseDate(today)
  const rows = db
    .prepare(
      `select id, event_name, target_date, window_days, tone_hint, last_fired_on, handled_at,
              subject_kind, subject_id, repeat, created_at
         from anchors
        where subject_kind = ? and subject_id = ? and repeat = 'none'
          and last_fired_on is null and handled_at is null`,
    )
    .all(subject.kind, subject.id) as unknown as AnchorRow[]

  return rows
    .map(toAnchor)
    .filter((anchor) => {
      const window = anchor.windowDays ?? defaultWindowDays
      const end = addDays(parseDate(anchor.targetDate), window)
      const age = daysBetween(todayDate, end)
      return age > 0 && age <= lookbackDays
    })
    .sort((a, b) => a.targetDate.localeCompare(b.targetDate))
}

/** All anchors, sorted by date; used by tests and a future browse command. */
export function listAnchors(db: DatabaseSync, subject?: SubjectRef): Anchor[] {
  const sql =
    subject === undefined
      ? `select id, event_name, target_date, window_days, tone_hint, last_fired_on, handled_at,
                subject_kind, subject_id, repeat, created_at
           from anchors order by target_date asc, id asc`
      : `select id, event_name, target_date, window_days, tone_hint, last_fired_on, handled_at,
                subject_kind, subject_id, repeat, created_at
           from anchors where subject_kind = ? and subject_id = ?
           order by target_date asc, id asc`
  const rows =
    subject === undefined
      ? (db.prepare(sql).all() as unknown as AnchorRow[])
      : (db.prepare(sql).all(subject.kind, subject.id) as unknown as AnchorRow[])
  return rows.map(toAnchor)
}

/** Record that an anchor was surfaced on `day` (idempotent per day). */
export function markAnchorFired(db: DatabaseSync, id: number, day: string): void {
  db.prepare('update anchors set last_fired_on = ? where id = ? and (last_fired_on is null or last_fired_on <> ?)').run(
    day,
    id,
    day,
  )
}

/** Record that the anchored event was handled (celebrated, paid, attended). */
export function markAnchorHandled(db: DatabaseSync, id: number, day: string): void {
  db.prepare('update anchors set handled_at = coalesce(handled_at, ?) where id = ?').run(day, id)
}
