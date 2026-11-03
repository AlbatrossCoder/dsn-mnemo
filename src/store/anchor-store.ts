/**
 * L3 anchors: dates that should surface on their own.
 *
 * An anchor is a single calendar date (`YYYY-MM-DD`). A window of ±N days
 * around it makes the memory fire; the window is stored per anchor when the
 * caller supplies one, otherwise the configured default applies.
 *
 * @module dsn-mnemo/store/anchor-store
 */
import type { DatabaseSync } from 'node:sqlite'

export interface AnchorInput {
  readonly eventName: string
  /** Local calendar date, `YYYY-MM-DD`. */
  readonly targetDate: string
  /** ± days around the target date; `null`/absent means the config default. */
  readonly windowDays?: number | null
  readonly toneHint?: string | null
}

export interface Anchor {
  readonly id: number
  readonly eventName: string
  readonly targetDate: string
  readonly windowDays: number | null
  readonly toneHint: string | null
  readonly lastFiredOn: string | null
  readonly createdAt: string
}

interface AnchorRow {
  id: number
  event_name: string
  target_date: string
  window_days: number | null
  tone_hint: string | null
  last_fired_on: string | null
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
    createdAt: row.created_at,
  }
}

/** Insert an anchor, or update the existing one with the same name and date. */
export function upsertAnchor(db: DatabaseSync, input: AnchorInput): number {
  const existing = db
    .prepare('select id from anchors where event_name = ? and target_date = ?')
    .get(input.eventName, input.targetDate) as { id: number } | undefined

  if (existing !== undefined) {
    db.prepare('update anchors set window_days = ?, tone_hint = ? where id = ?').run(
      input.windowDays ?? null,
      input.toneHint ?? null,
      existing.id,
    )
    return existing.id
  }

  const result = db
    .prepare(
      `insert into anchors(event_name, target_date, window_days, tone_hint)
       values (?, ?, ?, ?)`,
    )
    .run(input.eventName, input.targetDate, input.windowDays ?? null, input.toneHint ?? null)
  return Number(result.lastInsertRowid)
}

/** Anchors whose window contains `today`, earliest target first. */
export function anchorsInWindow(db: DatabaseSync, today: string, defaultWindowDays: number): Anchor[] {
  const rows = db
    .prepare(
      `select id, event_name, target_date, window_days, tone_hint, last_fired_on, created_at
         from anchors
        where abs(julianday(target_date) - julianday(?)) <= coalesce(window_days, ?)
        order by target_date asc, id asc`,
    )
    .all(today, defaultWindowDays) as unknown as AnchorRow[]
  return rows.map(toAnchor)
}

/** All anchors, sorted by date; used by tests and a future browse command. */
export function listAnchors(db: DatabaseSync): Anchor[] {
  const rows = db
    .prepare(
      `select id, event_name, target_date, window_days, tone_hint, last_fired_on, created_at
         from anchors order by target_date asc, id asc`,
    )
    .all() as unknown as AnchorRow[]
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
