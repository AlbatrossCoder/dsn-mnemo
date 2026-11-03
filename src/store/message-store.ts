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
import { cjkChars } from '../db/char-search.js'
import { buildAnyMatchQuery, buildMatchQuery, segment } from '../db/segment.js'

export type MessageRole = 'user' | 'assistant' | 'tool'

export interface MessageInput {
  readonly sessionId: string
  readonly seq: number
  readonly turn: number
  readonly role: MessageRole
  readonly messageId?: string | null
  /** Who spoke; null/absent for the assistant and for 1:1 local prompts. */
  readonly speakerId?: string | null
  /** True when the message addressed the assistant (@ / reply / mention). */
  readonly addressed?: boolean
  /** Flattened, human-searchable text. */
  readonly content: string
  /** Lossless JSON of the original message object. */
  readonly raw: string
}

/** Conversation shape a session belongs to. */
export interface SessionIdentity {
  readonly kind: 'dm' | 'group'
  readonly audienceId: string
}

export interface MessageHit {
  readonly id: number
  readonly sessionId: string
  readonly seq: number
  readonly turn: number
  readonly role: MessageRole
  readonly speakerId: string | null
  readonly content: string
  readonly createdAt: string
  /** Lower (more negative) is a better BM25 match. */
  readonly rank: number
}

/** Create the session row if needed and refresh its activity bookkeeping. */
export function touchSession(
  db: DatabaseSync,
  sessionId: string,
  turn: number,
  identity?: SessionIdentity,
): void {
  if (identity === undefined) {
    db.prepare(
      `insert into sessions(id, last_active_at, turn_count)
       values (?, datetime('now'), ?)
       on conflict(id) do update set
         last_active_at = excluded.last_active_at,
         turn_count = max(sessions.turn_count, excluded.turn_count)`,
    ).run(sessionId, turn)
    return
  }
  db.prepare(
    `insert into sessions(id, last_active_at, turn_count, kind, audience_id)
     values (?, datetime('now'), ?, ?, ?)
     on conflict(id) do update set
       last_active_at = excluded.last_active_at,
       turn_count = max(sessions.turn_count, excluded.turn_count),
       kind = excluded.kind,
       audience_id = excluded.audience_id`,
  ).run(sessionId, turn, identity.kind, identity.audienceId)
}

/** Insert one message; returns `false` when `(session_id, seq)` already existed. */
export function insertMessage(db: DatabaseSync, input: MessageInput): boolean {
  const result = db
    .prepare(
      `insert or ignore into messages(session_id, seq, turn, role, message_id, speaker_id, addressed, content, content_seg, raw)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sessionId,
      input.seq,
      input.turn,
      input.role,
      input.messageId ?? null,
      input.speakerId ?? null,
      input.addressed === true ? 1 : 0,
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
 * The precise AND query runs first; when it cannot fill the page, an OR query
 * widens the net (a long sentence otherwise requires every token to appear in
 * one message). Character matching is the last resort for rephrasings.
 *
 * @param query - raw query text, segmented with the index tokenizer.
 * @param limit - maximum hits after ordering.
 */
export function searchMessages(db: DatabaseSync, query: string, limit = 5): MessageHit[] {
  const hits: MessageHit[] = []
  const seen = new Set<number>()
  const push = (batch: MessageHit[]): void => {
    for (const hit of batch) {
      if (seen.has(hit.id)) continue
      seen.add(hit.id)
      hits.push(hit)
    }
  }

  const andMatch = buildMatchQuery(query)
  if (andMatch !== null) push(searchMessagesByMatch(db, andMatch, limit))

  if (hits.length < limit) {
    const orMatch = buildAnyMatchQuery(query)
    if (orMatch !== null) push(searchMessagesByMatch(db, orMatch, limit))
  }

  if (hits.length === 0) return searchMessagesByCharacters(db, query, limit)
  return hits.slice(0, limit)
}

function searchMessagesByMatch(db: DatabaseSync, match: string, limit: number): MessageHit[] {
  const rows = db
    .prepare(
      `select m.id, m.session_id, m.seq, m.turn, m.role, m.speaker_id, m.content, m.created_at,
              bm25(messages_fts) as rank
         from messages_fts
         join messages m on m.id = messages_fts.rowid
        where messages_fts match ?
        order by rank
        limit ?`,
    )
    .all(match, limit) as unknown as MessageRow[]

  return rows.map(toHit)
}

function searchMessagesByCharacters(db: DatabaseSync, query: string, limit: number): MessageHit[] {
  const chars = cjkChars(query)
  if (chars.length < 2) return []
  const where = chars.map(() => 'content like ?').join(' or ')
  const rows = db
    .prepare(
      `select id, session_id, seq, turn, role, speaker_id, content, created_at, 0 as rank
         from messages
        where ${where}
        order by created_at desc
        limit 50`,
    )
    .all(...chars.map((char) => `%${char}%`)) as unknown as MessageRow[]

  return rows
    .map((row) => ({ row, matched: chars.filter((char) => row.content.includes(char)).length }))
    .filter((candidate) => candidate.matched >= 2)
    .sort((a, b) => b.matched - a.matched || b.row.created_at.localeCompare(a.row.created_at))
    .slice(0, limit)
    .map(({ row }) => toHit(row))
}

interface MessageRow {
  id: number
  session_id: string
  seq: number
  turn: number
  role: MessageRole
  speaker_id: string | null
  content: string
  created_at: string
  rank: number
}

function toHit(row: MessageRow): MessageHit {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    turn: row.turn,
    role: row.role,
    speakerId: row.speaker_id,
    content: row.content,
    createdAt: row.created_at,
    rank: row.rank,
  }
}

/** Most recent messages of one session, oldest-first, for the working set. */
export function listRecentMessages(db: DatabaseSync, sessionId: string, limit = 20): MessageHit[] {
  const rows = db
    .prepare(
      `select id, session_id, seq, turn, role, speaker_id, content, created_at, 0 as rank
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
    speaker_id: string | null
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
    speakerId: row.speaker_id,
    content: row.content,
    createdAt: row.created_at,
    rank: row.rank,
  }))
}
