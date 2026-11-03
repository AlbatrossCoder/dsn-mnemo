/**
 * L0 exact-message persistence and retrieval.
 *
 * Rows are keyed by `(session_id, seq)` so replaying a session event that was
 * already captured is a no-op instead of a duplicate. The FTS index is fed by
 * a trigger from `content_seg`, exactly like diaries.
 *
 * @module dsn-mnemo/store/message-store
 */
import type { DatabaseSync } from 'node:sqlite'
import { buildMatchQuery, segment } from '../db/segment.js'

export type MessageRole = 'user' | 'assistant' | 'tool'

export interface MessageInput {
  readonly sessionId: string
  readonly seq: number
  readonly turn: number
  readonly role: MessageRole
  readonly messageId?: string | null
  /** Flattened, human-searchable text. */
  readonly content: string
  /** Lossless JSON of the original message object. */
  readonly raw: string
}

export interface MessageHit {
  readonly id: number
  readonly sessionId: string
  readonly seq: number
  readonly turn: number
  readonly role: MessageRole
  readonly content: string
  readonly createdAt: string
  /** Lower (more negative) is a better BM25 match. */
  readonly rank: number
}

/** Create the session row if needed and refresh its activity bookkeeping. */
export function touchSession(db: DatabaseSync, sessionId: string, turn: number): void {
  db.prepare(
    `insert into sessions(id, last_active_at, turn_count)
     values (?, datetime('now'), ?)
     on conflict(id) do update set
       last_active_at = excluded.last_active_at,
       turn_count = max(sessions.turn_count, excluded.turn_count)`,
  ).run(sessionId, turn)
}

/** Insert one message; returns `false` when `(session_id, seq)` already existed. */
export function insertMessage(db: DatabaseSync, input: MessageInput): boolean {
  const result = db
    .prepare(
      `insert or ignore into messages(session_id, seq, turn, role, message_id, content, content_seg, raw)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sessionId,
      input.seq,
      input.turn,
      input.role,
      input.messageId ?? null,
      input.content,
      segment(input.content),
      input.raw,
    )
  return result.changes > 0
}

/** Total stored messages, used by tests and diagnostics. */
export function countMessages(db: DatabaseSync): number {
  const row = db.prepare('select count(*) as total from messages').get() as { total: number } | undefined
  return row?.total ?? 0
}

/**
 * Keyword search over logged messages.
 *
 * @param query - raw query text, segmented with the index tokenizer.
 * @param limit - maximum hits after BM25 ordering.
 */
export function searchMessages(db: DatabaseSync, query: string, limit = 5): MessageHit[] {
  const match = buildMatchQuery(query)
  if (match === null) return []
  const rows = db
    .prepare(
      `select m.id, m.session_id, m.seq, m.turn, m.role, m.content, m.created_at,
              bm25(messages_fts) as rank
         from messages_fts
         join messages m on m.id = messages_fts.rowid
        where messages_fts match ?
        order by rank
        limit ?`,
    )
    .all(match, limit) as Array<{
    id: number
    session_id: string
    seq: number
    turn: number
    role: MessageRole
    content: string
    created_at: string
    rank: number
  }>

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    turn: row.turn,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    rank: row.rank,
  }))
}

/** Most recent messages of one session, oldest-first, for the working set. */
export function listRecentMessages(db: DatabaseSync, sessionId: string, limit = 20): MessageHit[] {
  const rows = db
    .prepare(
      `select id, session_id, seq, turn, role, content, created_at, 0 as rank
         from messages
        where session_id = ?
        order by seq desc
        limit ?`,
    )
    .all(sessionId, limit) as Array<{
    id: number
    session_id: string
    seq: number
    turn: number
    role: MessageRole
    content: string
    created_at: string
    rank: number
  }>

  return rows.reverse().map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    turn: row.turn,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    rank: row.rank,
  }))
}
