/**
 * The `recall` tool: dig into memory on demand.
 *
 * `scope=diary` searches L1 (BM25 + importance + recency). `scope=log`
 * searches L0 transcripts (BM25 + recency). Failures return an empty result
 * rather than an error: a missing memory must never look like a broken tool.
 *
 * @module dsn-mnemo/tools/recall
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DatabaseSync } from 'node:sqlite'
import { searchDiaries, type DiaryHit } from '../store/diary-store.js'
import { searchMessages } from '../store/message-store.js'

export type RecallScope = 'diary' | 'log'

export interface RecallHit {
  readonly source: RecallScope
  readonly id: number
  readonly text: string
  readonly score: number
  readonly when: string
}

export interface RecallOptions {
  readonly diaryLimit: number
  readonly logLimit: number
  /** Clock seam for deterministic tests. */
  readonly now?: () => Date
}

const DAY_MS = 86_400_000

function recency(when: string, now: Date): number {
  const parsed = Date.parse(`${when.replace(' ', 'T')}Z`)
  if (Number.isNaN(parsed)) return 0
  const ageDays = Math.max(0, (now.getTime() - parsed) / DAY_MS)
  return 1 / (1 + ageDays)
}

/** Normalise BM25 ranks into 0..1 where 1 is the best hit of the batch. */
function normalise(ranks: readonly number[]): (rank: number) => number {
  if (ranks.length === 0) return () => 0
  const best = Math.min(...ranks)
  const worst = Math.max(...ranks)
  if (best === worst) return () => 1
  return (rank) => (worst - rank) / (worst - best)
}

/** Blend BM25, importance, and recency into a 0..1 score per diary hit. */
export function rankDiaryHits(hits: readonly DiaryHit[], limit: number, now: Date): RecallHit[] {
  if (hits.length === 0) return []
  const bm = normalise(hits.map((hit) => hit.rank))
  return hits
    .map((hit) => ({
      source: 'diary' as const,
      id: hit.id,
      text: hit.content,
      score: 0.6 * bm(hit.rank) + 0.25 * hit.importance + 0.15 * recency(hit.createdAt, now),
      when: hit.createdAt,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/** Rank diaries by BM25, importance, and recency. */
export function rankDiaries(db: DatabaseSync, query: string, limit: number, now = new Date()): RecallHit[] {
  return rankDiaryHits(searchDiaries(db, query, limit * 2), limit, now)
}

/** Rank transcript messages by BM25 and recency. */
export function rankLogs(db: DatabaseSync, query: string, limit: number, now = new Date()): RecallHit[] {
  const hits = searchMessages(db, query, limit * 2)
  if (hits.length === 0) return []
  const bm = normalise(hits.map((hit) => hit.rank))
  return hits
    .map((hit) => ({
      source: 'log' as const,
      id: hit.id,
      text: `[${hit.role}] ${hit.content}`,
      score: 0.85 * bm(hit.rank) + 0.15 * recency(hit.createdAt, now),
      when: hit.createdAt,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/** Run one recall query; never throws. */
export function recall(
  db: DatabaseSync,
  query: string,
  scope: RecallScope,
  limit: number,
  now = new Date(),
): RecallHit[] {
  try {
    return scope === 'log' ? rankLogs(db, query, limit, now) : rankDiaries(db, query, limit, now)
  } catch {
    return []
  }
}

/** Build the registry-ready `recall` tool bound to one database. */
export function createRecallTool(db: DatabaseSync, options: RecallOptions) {
  const now = options.now ?? (() => new Date())
  return defineTool({
    name: 'recall',
    description:
      'Search mnemo memory when the user references the past, or when an earlier detail would change the answer. scope=diary searches distilled diaries; scope=log searches the raw transcript. Returns an empty list when nothing matches.',
    parameters: {
      query: {
        type: 'string',
        description: 'Keywords to search for, in natural language.',
        required: true,
      },
      scope: {
        type: 'string',
        enum: ['diary', 'log'],
        description: 'diary = distilled memories (default), log = raw transcript lines.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum hits to return; defaults to the configured limit.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['diary', 'log'] },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                source: { type: 'string', enum: ['diary', 'log'] },
                text: { type: 'string' },
                score: { type: 'number' },
                when: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const results = value.results ?? []
        return [
          {
            type: 'text',
            text:
              results.length === 0
                ? `no ${value.scope} memories matched`
                : results.map((hit) => `- ${hit.text}`).join('\n'),
          },
        ]
      },
    },
    async execute(args) {
      const scope: RecallScope = args.scope === 'log' ? 'log' : 'diary'
      const fallback = scope === 'log' ? options.logLimit : options.diaryLimit
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 50) : fallback
      return { scope, results: recall(db, args.query, scope, limit, now()) }
    },
  })
}
