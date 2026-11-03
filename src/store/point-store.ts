/**
 * L2 memory points: the short-term layer.
 *
 * A point is one short sentence about something recent — a topic, an event, a
 * person, an open thread. Points expire (7 days by default) and are retrieved
 * by association with the current message, not by a fixed top-N.
 *
 * @module dsn-mnemo/store/point-store
 */
import type { DatabaseSync } from 'node:sqlite'
import { CHAR_FALLBACK_RANK, CHAR_FALLBACK_SCAN_LIMIT, cjkChars } from '../db/char-search.js'
import { buildAnyMatchQuery, buildMatchQuery, segment } from '../db/segment.js'
import { insertDiary, type SubjectRef } from './diary-store.js'

export type PointKind = 'topic' | 'event' | 'person' | 'open_thread'

export interface PointInput {
  readonly subject: SubjectRef
  readonly text: string
  readonly kind?: PointKind
  readonly importance?: number
  /** Where the point came from: `diary`, `scribe`, `manual`. */
  readonly source?: string
  /** Days until expiry; defaults to 7. */
  readonly ttlDays?: number
}

export interface PointHit {
  readonly id: number
  readonly subjectKind: string
  readonly subjectId: string
  readonly kind: PointKind
  readonly text: string
  readonly importance: number
  readonly createdAt: string
  readonly expiresAt: string
  /** Lower (more negative) is a better BM25 match. */
  readonly rank: number
}

interface PointRow {
  id: number
  subject_kind: string
  subject_id: string
  kind: string
  text: string
  importance: number
  created_at: string
  expires_at: string
  rank: number
}

function toHit(row: PointRow): PointHit {
  return {
    id: row.id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    kind: row.kind as PointKind,
    text: row.text,
    importance: row.importance,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    rank: row.rank,
  }
}

/** Persist one point and return its row id. */
export function insertPoint(db: DatabaseSync, input: PointInput): number {
  const ttl = input.ttlDays ?? 7
  const result = db
    .prepare(
      `insert into memory_points(subject_kind, subject_id, kind, text, content_seg, importance, source, expires_at)
       values (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`,
    )
    .run(
      input.subject.kind,
      input.subject.id,
      input.kind ?? 'topic',
      input.text,
      segment(input.text),
      input.importance ?? 0.5,
      input.source ?? 'diary',
      `${ttl >= 0 ? "+" : ""}${ttl} days`,
    )
  return Number(result.lastInsertRowid)
}

/** Remove expired points; returns how many rows were deleted. */
export function purgeExpiredPoints(db: DatabaseSync): number {
  const result = db.prepare("delete from memory_points where expires_at <= datetime('now')").run()
  return Number(result.changes)
}

const PROMOTE_IMPORTANCE = 0.85
const PROMOTE_MENTIONS = 2

export interface RecordedPoint {
  readonly id: number
  readonly mentions: number
  readonly promoted: boolean
}

/**
 * Record a point, merging an identical live one.
 *
 * A point becomes a diary when it is mentioned again (`mentions >= 2`) or when
 * it already carries high importance. Promotion happens once (`promoted = 1`).
 */
export function recordPoint(db: DatabaseSync, input: PointInput): RecordedPoint {
  const text = input.text.trim()
  if (text.length === 0) throw new Error('point text must not be empty')
  const importance = input.importance ?? 0.5

  const existing = db
    .prepare(
      `select id, mentions, promoted, importance from memory_points
        where subject_kind = ? and subject_id = ? and text = ? and expires_at > datetime('now')`,
    )
    .get(input.subject.kind, input.subject.id, text) as
    | { id: number; mentions: number; promoted: number; importance: number }
    | undefined

  if (existing !== undefined) {
    const mentions = existing.mentions + 1
    const mergedImportance = Math.max(existing.importance, importance)
    db.prepare('update memory_points set mentions = ?, last_seen_at = datetime(\'now\'), importance = ? where id = ?').run(
      mentions,
      mergedImportance,
      existing.id,
    )
    const shouldPromote = existing.promoted === 0 && (mentions >= PROMOTE_MENTIONS || mergedImportance >= PROMOTE_IMPORTANCE)
    if (shouldPromote) {
      insertDiary(db, {
        subjectKind: input.subject.kind,
        subjectId: input.subject.id,
        visibility: input.subject.kind === 'group' ? 'public' : 'private',
        content: text,
        importance: mergedImportance,
        typeTags: ['记忆点晋升'],
      })
      db.prepare('update memory_points set promoted = 1 where id = ?').run(existing.id)
    }
    return { id: existing.id, mentions, promoted: existing.promoted === 1 || shouldPromote }
  }

  const ttl = input.ttlDays ?? 7
  const result = db
    .prepare(
      `insert into memory_points(subject_kind, subject_id, kind, text, content_seg, importance, source, expires_at)
       values (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`,
    )
    .run(
      input.subject.kind,
      input.subject.id,
      input.kind ?? 'topic',
      text,
      segment(text),
      importance,
      input.source ?? 'diary',
      `${ttl >= 0 ? "+" : ""}${ttl} days`,
    )
  const id = Number(result.lastInsertRowid)
  const promoted = importance >= PROMOTE_IMPORTANCE
  if (promoted) {
    insertDiary(db, {
      subjectKind: input.subject.kind,
      subjectId: input.subject.id,
      visibility: input.subject.kind === 'group' ? 'public' : 'private',
      content: text,
      importance,
      typeTags: ['记忆点晋升'],
    })
    db.prepare('update memory_points set promoted = 1 where id = ?').run(id)
  }
  return { id, mentions: 1, promoted }
}

/** Number of live points for a subject. */
export function countPoints(db: DatabaseSync, subject: SubjectRef): number {
  const row = db
    .prepare(
      "select count(*) as total from memory_points where subject_kind = ? and subject_id = ? and expires_at > datetime('now')",
    )
    .get(subject.kind, subject.id) as { total: number } | undefined
  return row?.total ?? 0
}

/**
 * Search live points of one subject.
 *
 * Tries the precise AND query first, widens to OR when it cannot fill the page,
 * then falls back to character matching for rephrasings.
 */
export function searchPoints(
  db: DatabaseSync,
  query: string,
  subject: SubjectRef,
  limit = 20,
  mode: 'and' | 'or' = 'or',
): PointHit[] {
  const hits: PointHit[] = []
  const seen = new Set<number>()
  const push = (batch: PointHit[]): void => {
    for (const hit of batch) {
      if (seen.has(hit.id)) continue
      seen.add(hit.id)
      hits.push(hit)
    }
  }

  if (mode === 'and') {
    const andMatch = buildMatchQuery(query)
    if (andMatch !== null) push(searchPointsByMatch(db, andMatch, subject, limit))
  }
  if (hits.length < limit) {
    const orMatch = buildAnyMatchQuery(query)
    if (orMatch !== null) push(searchPointsByMatch(db, orMatch, subject, limit))
  }
  if (hits.length < limit) push(searchPointsByCharacters(db, query, subject, limit))
  return hits.slice(0, limit)
}

function searchPointsByMatch(db: DatabaseSync, match: string, subject: SubjectRef, limit: number): PointHit[] {
  const rows = db
    .prepare(
      `select p.id, p.subject_kind, p.subject_id, p.kind, p.text, p.importance,
              p.created_at, p.expires_at, bm25(memory_points_fts) as rank
         from memory_points_fts
         join memory_points p on p.id = memory_points_fts.rowid
        where memory_points_fts match ?
          and p.subject_kind = ? and p.subject_id = ?
          and p.expires_at > datetime('now')
        order by rank
        limit ?`,
    )
    .all(match, subject.kind, subject.id, limit) as unknown as PointRow[]
  return rows.map(toHit)
}

function searchPointsByCharacters(db: DatabaseSync, query: string, subject: SubjectRef, limit: number): PointHit[] {
  const chars = cjkChars(query)
  if (chars.length < 2) return []
  const where = chars.map(() => 'text like ?').join(' or ')
  const rows = db
    .prepare(
      `select id, subject_kind, subject_id, kind, text, importance, created_at, expires_at, ${CHAR_FALLBACK_RANK} as rank
         from memory_points
        where (${where}) and subject_kind = ? and subject_id = ? and expires_at > datetime('now')
        order by id desc
        limit ${CHAR_FALLBACK_SCAN_LIMIT}`,
    )
    .all(...chars.map((char) => `%${char}%`), subject.kind, subject.id) as unknown as PointRow[]
  return rows
    .map((row) => ({ row, matched: chars.filter((char) => row.text.includes(char)).length }))
    .filter((candidate) => candidate.matched >= 2)
    .sort((a, b) => b.matched - a.matched || b.row.created_at.localeCompare(a.row.created_at))
    .slice(0, limit)
    .map(({ row }) => toHit(row))
}
