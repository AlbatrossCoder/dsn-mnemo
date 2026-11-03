/**
 * L1 diary persistence and retrieval.
 *
 * A diary row stores both the original text and its segmented form. The FTS5
 * index is fed by a trigger from `content_seg`, so {@link searchDiaries} never
 * has to re-tokenise stored rows.
 *
 * @module dsn-mnemo/store/diary-store
 */
import type { DatabaseSync } from 'node:sqlite'
import { buildMatchQuery, segment } from '../db/segment.js'

export interface DiaryInput {
  readonly content: string
  readonly sessionId?: string | null
  /** 0..1, used later by the recency/importance blend. */
  readonly importance?: number
  /** 0..1 mood label. */
  readonly emotion?: number
  /** Free-form tags such as `['日常', '约定']`. */
  readonly typeTags?: readonly string[]
}

export interface DiaryHit {
  readonly id: number
  readonly content: string
  readonly importance: number
  readonly emotion: number
  readonly typeTags: readonly string[]
  readonly createdAt: string
  /** Lower (more negative) is a better BM25 match. */
  readonly rank: number
}

/** Persist one diary and return its row id. */
export function insertDiary(db: DatabaseSync, input: DiaryInput): number {
  const statement = db.prepare(
    `insert into diaries(session_id, content, content_seg, importance, emotion, type_tags)
     values (?, ?, ?, ?, ?, ?)`,
  )
  const result = statement.run(
    input.sessionId ?? null,
    input.content,
    segment(input.content),
    input.importance ?? 0.5,
    input.emotion ?? 0.5,
    (input.typeTags ?? []).join(','),
  )
  return Number(result.lastInsertRowid)
}

/** Number of stored diaries, used by the relation-stage score later. */
export function countDiaries(db: DatabaseSync): number {
  const row = db.prepare('select count(*) as total from diaries').get() as { total: number } | undefined
  return row?.total ?? 0
}

/**
 * Keyword search over diaries.
 *
 * @param query - raw query; segmented with the same tokenizer as the index.
 * @param limit - maximum hits after BM25 ordering.
 * @returns hits ordered best-first; an empty array when nothing is searchable.
 */
export function searchDiaries(db: DatabaseSync, query: string, limit = 5): DiaryHit[] {
  const match = buildMatchQuery(query)
  if (match === null) return []
  const rows = db
    .prepare(
      `select d.id, d.content, d.importance, d.emotion, d.type_tags, d.created_at,
              bm25(diaries_fts) as rank
         from diaries_fts
         join diaries d on d.id = diaries_fts.rowid
        where diaries_fts match ?
        order by rank
        limit ?`,
    )
    .all(match, limit) as Array<{
    id: number
    content: string
    importance: number
    emotion: number
    type_tags: string
    created_at: string
    rank: number
  }>

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    importance: row.importance,
    emotion: row.emotion,
    typeTags: row.type_tags.length === 0 ? [] : row.type_tags.split(','),
    createdAt: row.created_at,
    rank: row.rank,
  }))
}
