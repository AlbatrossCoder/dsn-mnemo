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
import { searchDiaries, type DiaryHit, type SubjectRef } from '../store/diary-store.js'
import { searchMessages, sessionSubject } from '../store/message-store.js'

export type RecallScope = 'diary' | 'log'
export type RecallSource = RecallScope

export interface RecallHit {
  readonly source: RecallSource
  readonly id: number
  readonly text: string
  readonly score: number
  readonly when: string
}

/** Rough token estimate: one CJK character or four Latin characters. */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length
  return Math.ceil(cjk + (text.length - cjk) / 4)
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
export function rankDiaries(
  db: DatabaseSync,
  query: string,
  limit: number,
  now = new Date(),
  subject?: SubjectRef,
): RecallHit[] {
  const hits = searchDiaries(db, query, limit * 2, 'and', subject).filter(
    // `secret` never appears in a group, even when the query matches.
    (hit) => subject?.kind !== 'group' || hit.visibility !== 'secret',
  )
  return rankDiaryHits(hits, limit, now)
}

/**
 * Rank transcript messages by BM25 and recency.
 *
 * @param excludeSessionId - the calling session, whose content the model can
 *   already see; excluding it keeps recall focused on older conversations and
 *   stops it from matching its own tool-call transcript.
 */
export function rankLogs(
  db: DatabaseSync,
  query: string,
  limit: number,
  now = new Date(),
  excludeSessionId?: string,
  subject?: SubjectRef,
): RecallHit[] {
  const hits = searchMessages(db, query, limit * 5, subject).filter(
    (hit) =>
      hit.sessionId !== excludeSessionId &&
      // Tool-call echoes make a recall query match its own call record; they are
      // never the memory a user means when asking about the past.
      !(hit.role === 'assistant' && hit.content.trimStart().startsWith('[call ')),
  )
  if (hits.length === 0) return []
  const bm = normalise(hits.map((hit) => hit.rank))
  const scored = hits
    .map((hit) => ({
      hit,
      score: 0.85 * bm(hit.rank) + 0.15 * recency(hit.createdAt, now),
    }))
    .sort((a, b) => b.score - a.score)

  // Round-robin across sessions: a recall for old conversations must not be
  // monopolised by this session's own tool-call echoes.
  const bySession = new Map<string, typeof scored>()
  for (const item of scored) {
    const list = bySession.get(item.hit.sessionId) ?? []
    list.push(item)
    bySession.set(item.hit.sessionId, list)
  }
  const queues = [...bySession.values()]
  const out: RecallHit[] = []
  while (out.length < limit && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift()
      if (next === undefined) continue
      out.push({
        source: 'log',
        id: next.hit.id,
        text: `[${next.hit.role}] ${next.hit.content}`,
        score: next.score,
        when: next.hit.createdAt,
      })
      if (out.length >= limit) break
    }
  }
  return out
}

/** Run one recall query; never throws. */
export function recall(
  db: DatabaseSync,
  query: string,
  scope: RecallScope,
  limit: number,
  now = new Date(),
  excludeSessionId?: string,
  subject?: SubjectRef,
): RecallHit[] {
  try {
    return scope === 'log'
      ? rankLogs(db, query, limit, now, excludeSessionId, subject)
      : rankDiaries(db, query, limit, now, subject)
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
      'Search mnemo memory when the user references the past, or when an earlier detail would change the answer. scope=diary searches distilled diaries; scope=log searches transcripts from earlier sessions (the current conversation is already in context). Returns an empty list when nothing matches.',
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
                id: { type: 'number' },
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
    async execute(args, exec) {
      const scope: RecallScope = args.scope === 'log' ? 'log' : 'diary'
      const fallback = scope === 'log' ? options.logLimit : options.diaryLimit
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 50) : fallback
      const sessionId = exec.agent?.session.id
      const subject = sessionId === undefined ? undefined : sessionSubject(db, sessionId)
      return { scope, results: recall(db, args.query, scope, limit, now(), sessionId, subject) }
    },
  })
}
