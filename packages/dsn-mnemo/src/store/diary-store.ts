/**
 * L1 diary persistence and retrieval.
 *
 * A diary row stores both the original text and its segmented form. The FTS5
 * index is fed by a trigger from `content_seg`, so {@link searchDiaries} never
 * has to re-tokenise stored rows.
 *
 * Diaries belong to a subject: `user:<id>` for a person, `group:<id>` for a
 * group. Every read path can filter by that subject.
 *
 * @module dsn-mnemo/store/diary-store
 */
import type { DatabaseSync } from 'node:sqlite'
import { CHAR_FALLBACK_RANK, CHAR_FALLBACK_SCAN_LIMIT, cjkChars } from '../db/char-search.js'
import { buildAnyMatchQuery, buildMatchQuery, segment } from '../db/segment.js'
import { diaryAccessClause, isMemoryAccess, type MemoryAccess } from '../memory/visibility.js'

export type SubjectKind = 'user' | 'group'
export type Visibility = 'public' | 'private' | 'secret'

/** A memory owner: one person or one group. */
export interface SubjectRef {
  readonly kind: SubjectKind
  readonly id: string
}

export interface DiaryInput {
  readonly content: string
  readonly sessionId?: string | null
  readonly subjectKind?: SubjectKind | null
  readonly subjectId?: string | null
  readonly visibility?: Visibility
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
  readonly subjectKind: SubjectKind | null
  readonly subjectId: string | null
  readonly visibility: Visibility
  readonly createdAt: string
  /** Lower (more negative) is a better BM25 match. */
  readonly rank: number
}

interface DiaryRow {
  id: number
  content: string
  importance: number
  emotion: number
  type_tags: string
  subject_kind: string | null
  subject_id: string | null
  visibility: string
  created_at: string
  rank: number
}

function toHit(row: DiaryRow): DiaryHit {
  return {
    id: row.id,
    content: row.content,
    importance: row.importance,
    emotion: row.emotion,
    typeTags: row.type_tags.length === 0 ? [] : row.type_tags.split(','),
    subjectKind: row.subject_kind as SubjectKind | null,
    subjectId: row.subject_id,
    visibility: row.visibility as Visibility,
    createdAt: row.created_at,
    rank: row.rank,
  }
}

/** Persist one diary and return its row id. */
export function insertDiary(db: DatabaseSync, input: DiaryInput): number {
  const statement = db.prepare(
    `insert into diaries(session_id, subject_kind, subject_id, visibility, content, content_seg, importance, emotion, type_tags)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const result = statement.run(
    input.sessionId ?? null,
    input.subjectKind ?? null,
    input.subjectId ?? null,
    input.visibility ?? 'private',
    input.content,
    segment(input.content),
    input.importance ?? 0.5,
    input.emotion ?? 0.5,
    (input.typeTags ?? []).join(','),
  )
  return Number(result.lastInsertRowid)
}

/** Number of stored diaries, used by diagnostics. */
export function countDiaries(db: DatabaseSync): number {
  const row = db.prepare('select count(*) as total from diaries').get() as { total: number } | undefined
  return row?.total ?? 0
}

/** Number of diaries written for one subject today (local calendar day). */
export function countDiariesForToday(db: DatabaseSync, subject: SubjectRef): number {
  const row = db
    .prepare(
      `select count(*) as total from diaries
        where subject_kind = ? and subject_id = ? and created_at >= datetime('now', 'start of day')`,
    )
    .get(subject.kind, subject.id) as { total: number } | undefined
  return row?.total ?? 0
}

/**
 * Keyword search over diaries.
 *
 * Word segmentation is exact: 「看了海」 indexes as `看了` + `海`, so a query
 * for `看海` finds nothing. When the token search is empty we fall back to a
 * character match (`看` AND `海`), which is what makes natural rephrasings
 * recallable. The fallback loses BM25 ordering, so scores rely on importance
 * and recency instead.
 *
 * @param query - raw query; segmented with the same tokenizer as the index.
 * @param limit - maximum hits after ordering.
 * @param mode - `and` for short keyword queries, `or` for whole sentences.
 * @param scope - one subject, or a {@link MemoryAccess} union; omit for a global scan.
 * @returns hits ordered best-first; an empty array when nothing is searchable.
 */
export function searchDiaries(
  db: DatabaseSync,
  query: string,
  limit = 5,
  mode: 'and' | 'or' = 'and',
  scope?: SubjectRef | MemoryAccess,
): DiaryHit[] {
  const hits: DiaryHit[] = []
  const seen = new Set<number>()
  const push = (batch: DiaryHit[]): void => {
    for (const hit of batch) {
      if (seen.has(hit.id)) continue
      seen.add(hit.id)
      hits.push(hit)
    }
  }

  const match = mode === 'or' ? buildAnyMatchQuery(query) : buildMatchQuery(query)
  if (match !== null) push(searchDiariesByMatch(db, match, limit, scope))
  if (hits.length < limit) push(searchDiariesByCharacters(db, query, limit, scope))
  return hits.slice(0, limit)
}

function diaryScopeSql(scope: SubjectRef | MemoryAccess | undefined, alias: string): { sql: string; params: string[] } {
  if (scope === undefined) return { sql: '', params: [] }
  if (isMemoryAccess(scope)) return diaryAccessClause(scope, alias)
  return {
    sql: `and ${alias}subject_kind = ? and ${alias}subject_id = ?`,
    params: [scope.kind, scope.id],
  }
}

/**
 * Last-resort character search.
 *
 * A rephrasing such as 「看海」 against a diary that says 「看了海」 shares no
 * token with the index, so we fall back to characters: candidate rows match at
 * least two meaningful Han characters, then rank by how many they match and how
 * recent they are. Requiring every character would be too strict for sentences
 * that carry filler characters.
 */
function searchDiariesByCharacters(
  db: DatabaseSync,
  query: string,
  limit: number,
  scope?: SubjectRef | MemoryAccess,
): DiaryHit[] {
  const chars = cjkChars(query)
  if (chars.length < 2) return []
  const where = chars.map(() => 'content like ?').join(' or ')
  const filter = diaryScopeSql(scope, '')
  const params: Array<string | number> = [...chars.map((char) => `%${char}%`), ...filter.params]
  const rows = db
    .prepare(
      `select id, content, importance, emotion, type_tags, subject_kind, subject_id, visibility, created_at, ${CHAR_FALLBACK_RANK} as rank
         from diaries
        where (${where}) ${filter.sql}
        order by id desc
        limit ${CHAR_FALLBACK_SCAN_LIMIT}`,
    )
    .all(...params) as unknown as DiaryRow[]

  return rows
    .map((row) => ({
      row,
      matched: chars.filter((char) => row.content.includes(char)).length,
    }))
    .filter((candidate) => candidate.matched >= 2)
    .sort((a, b) => b.matched - a.matched || b.row.created_at.localeCompare(a.row.created_at))
    .slice(0, limit)
    .map(({ row }) => toHit(row))
}

/**
 * Run a pre-built FTS5 MATCH expression, e.g. an OR query for whole sentences.
 *
 * @param match - quoted FTS5 expression produced by `segment.ts` helpers.
 * @param scope - one subject, or a scene access union.
 */
export function searchDiariesByMatch(
  db: DatabaseSync,
  match: string,
  limit = 5,
  scope?: SubjectRef | MemoryAccess,
): DiaryHit[] {
  const filter = diaryScopeSql(scope, 'd.')
  const params: Array<string | number> = [match, ...filter.params, limit]
  const rows = db
    .prepare(
      `select d.id, d.content, d.importance, d.emotion, d.type_tags,
              d.subject_kind, d.subject_id, d.visibility, d.created_at,
              bm25(diaries_fts) as rank
         from diaries_fts
         join diaries d on d.id = diaries_fts.rowid
        where diaries_fts match ? ${filter.sql}
        order by rank
        limit ?`,
    )
    .all(...params) as unknown as DiaryRow[]

  return rows.map((row) => toHit(row))
}

/** Newest diaries for one subject, or for a scene's access union. Group rows are public-only. */
export function recentDiaries(db: DatabaseSync, scope: SubjectRef | MemoryAccess, limit: number): DiaryHit[] {
  if (isMemoryAccess(scope)) {
    const filter = diaryScopeSql(scope, '')
    const rows = db
      .prepare(
        `select id, content, importance, emotion, type_tags, subject_kind, subject_id, visibility, created_at, 0 as rank
           from diaries
          where 1 = 1 ${filter.sql}
          order by created_at desc, id desc
          limit ?`,
      )
      .all(...filter.params, limit) as unknown as DiaryRow[]
    return rows.map((row) => toHit(row))
  }
  const visibility = scope.kind === 'group' ? "and visibility = 'public'" : ''
  const rows = db
    .prepare(
      `select id, content, importance, emotion, type_tags, subject_kind, subject_id, visibility, created_at, 0 as rank
         from diaries
        where subject_kind = ? and subject_id = ? ${visibility}
        order by created_at desc, id desc
        limit ?`,
    )
    .all(scope.kind, scope.id, limit) as unknown as DiaryRow[]
  return rows.map((row) => toHit(row))
}
