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
import { buildAnyMatchQuery, buildMatchQuery, segment } from '../db/segment.js'

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
 * Word segmentation is exact: 「看了海」 indexes as `看了` + `海`, so a query
 * for `看海` finds nothing. When the token search is empty we fall back to a
 * character match (`看` AND `海`), which is what makes natural rephrasings
 * recallable. The fallback loses BM25 ordering, so scores rely on importance
 * and recency instead.
 *
 * @param query - raw query; segmented with the same tokenizer as the index.
 * @param limit - maximum hits after ordering.
 * @param mode - `and` for short keyword queries, `or` for whole sentences.
 * @returns hits ordered best-first; an empty array when nothing is searchable.
 */
export function searchDiaries(
  db: DatabaseSync,
  query: string,
  limit = 5,
  mode: 'and' | 'or' = 'and',
): DiaryHit[] {
  const match = mode === 'or' ? buildAnyMatchQuery(query) : buildMatchQuery(query)
  if (match !== null) {
    const hits = searchDiariesByMatch(db, match, limit)
    if (hits.length > 0) return hits
  }
  return searchDiariesByCharacters(db, query, limit)
}

/** Characters that carry no retrieval value on their own. */
const CJK_STOPWORDS = new Set(
  '的了是在我有和就不没都会要你他她它吗呢吧啊很太这那也还个上下着过把被让给对从到说想'.split(''),
)

/**
 * Last-resort character search.
 *
 * A rephrasing such as 「看海」 against a diary that says 「看了海」 shares no
 * token with the index, so we fall back to characters: candidate rows match at
 * least two meaningful Han characters, then rank by how many they match and how
 * recent they are. Requiring every character would be too strict for sentences
 * that carry filler characters.
 */
function searchDiariesByCharacters(db: DatabaseSync, query: string, limit: number): DiaryHit[] {
  const unique = [...new Set([...query].filter((char) => /\p{Script=Han}/u.test(char) && !CJK_STOPWORDS.has(char)))]
  if (unique.length < 2) return []
  const chars = unique.slice(0, 8)
  const where = chars.map(() => 'content like ?').join(' or ')
  const rows = db
    .prepare(
      `select id, content, importance, emotion, type_tags, created_at, 0 as rank
         from diaries
        where ${where}
        order by created_at desc
        limit 50`,
    )
    .all(...chars.map((char) => `%${char}%`)) as Array<{
    id: number
    content: string
    importance: number
    emotion: number
    type_tags: string
    created_at: string
    rank: number
  }>

  return rows
    .map((row) => ({
      row,
      matched: chars.filter((char) => row.content.includes(char)).length,
    }))
    .filter((candidate) => candidate.matched >= 2)
    .sort((a, b) => b.matched - a.matched || b.row.created_at.localeCompare(a.row.created_at))
    .slice(0, limit)
    .map(({ row }) => ({
      id: row.id,
      content: row.content,
      importance: row.importance,
      emotion: row.emotion,
      typeTags: row.type_tags.length === 0 ? [] : row.type_tags.split(','),
      createdAt: row.created_at,
      rank: row.rank,
    }))
}

/**
 * Run a pre-built FTS5 MATCH expression, e.g. an OR query for whole sentences.
 *
 * @param match - quoted FTS5 expression produced by `segment.ts` helpers.
 */
export function searchDiariesByMatch(db: DatabaseSync, match: string, limit = 5): DiaryHit[] {
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
