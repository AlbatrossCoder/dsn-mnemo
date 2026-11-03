/**
 * The diary engine: after a completed turn goes quiet for the configured idle
 * window, ask a small model call whether the conversation deserves a diary.
 *
 * Timers live in memory but `sessions.last_active_at` is persisted, so a
 * restart can catch up on sessions that went quiet while the process was down.
 *
 * @module dsn-mnemo/diary/engine
 */
import type { DatabaseSync } from 'node:sqlite'
import { insertDiary } from '../store/diary-store.js'
import { buildJudgePrompt, parseDiaryResponse } from './judge.js'

/** Injectable timer seam so tests never wait thirty real minutes. */
export interface Scheduler {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

const defaultScheduler: Scheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface DiaryEngineOptions {
  readonly db: DatabaseSync
  /** One short model call; must resolve to the raw answer text. */
  readonly generate: (prompt: string) => Promise<string>
  /** Quiet time after a completed turn before judging. */
  readonly idleMs: number
  /** Hard cap on diaries written per session. */
  readonly maxPerSession: number
  readonly personaHint?: string
  readonly scheduler?: Scheduler
  readonly now?: () => Date
}

interface MessageRow {
  role: string
  content: string
}

interface SessionRow {
  id: string
  last_active_at: string
  diary_judged_at: string | null
}

const RECENT_MESSAGE_LIMIT = 12
const MIN_TRANSCRIPT_CHARS = 30
const MAX_CATCH_UP_AGE_MS = 30 * 86_400_000

export class DiaryEngine {
  private readonly timers = new Map<string, unknown>()
  private readonly scheduler: Scheduler
  private disposed = false

  constructor(private readonly options: DiaryEngineOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler
  }

  /** Arm (or re-arm) the idle timer for one session. */
  noteTurnEnd(sessionId: string): void {
    if (this.disposed) return
    this.cancel(sessionId)
    const handle = this.scheduler.set(() => {
      this.timers.delete(sessionId)
      void this.flush(sessionId)
    }, this.options.idleMs)
    this.timers.set(sessionId, handle)
  }

  /** Cancel the pending judgement because the session is active again. */
  noteActivity(sessionId: string): void {
    this.cancel(sessionId)
  }

  /** Number of armed timers; used by tests. */
  get pending(): number {
    return this.timers.size
  }

  /**
   * Judge and (maybe) write one session's diary now.
   *
   * @returns whether a diary was written.
   */
  async flush(sessionId: string): Promise<boolean> {
    const { db } = this.options
    try {
      const written = db
        .prepare('select count(*) as total from diaries where session_id = ?')
        .get(sessionId) as { total: number } | undefined
      if ((written?.total ?? 0) >= this.options.maxPerSession) return false

      const rows = db
        .prepare('select role, content from messages where session_id = ? order by seq desc limit ?')
        .all(sessionId, RECENT_MESSAGE_LIMIT) as unknown as MessageRow[]
      if (rows.length < 2) return false

      const transcript = rows
        .reverse()
        .map((row) => `${row.role}: ${row.content}`)
        .join('\n')
      if (transcript.length < MIN_TRANSCRIPT_CHARS) return false

      // Mark before calling: a provider outage must not make every later
      // reload judge the same quiet session again.
      db.prepare("update sessions set diary_judged_at = datetime('now') where id = ?").run(sessionId)

      const answer = await this.options.generate(
        buildJudgePrompt({ transcript, personaHint: this.options.personaHint }),
      )
      const decision = parseDiaryResponse(answer)
      if (decision === null) return false

      insertDiary(db, {
        sessionId,
        content: decision.content,
        importance: decision.importance,
        emotion: decision.emotion,
        typeTags: decision.tags,
      })
      return true
    } catch {
      // A failed judgement must never surface to the conversation.
      return false
    }
  }

  /**
   * Judge sessions that went quiet while the process was not running.
   *
   * @returns how many diaries were written.
   */
  async catchUp(): Promise<number> {
    const { db } = this.options
    const now = this.options.now?.() ?? new Date()
    let written = 0
    try {
      const rows = db
        .prepare('select id, last_active_at, diary_judged_at from sessions where turn_count > 0')
        .all() as unknown as SessionRow[]
      for (const row of rows) {
        const lastActive = Date.parse(`${row.last_active_at.replace(' ', 'T')}Z`)
        if (Number.isNaN(lastActive)) continue
        const age = now.getTime() - lastActive
        if (age < this.options.idleMs || age > MAX_CATCH_UP_AGE_MS) continue
        // Already judged this quiet stretch (possibly before a restart).
        if (row.diary_judged_at !== null) {
          const judged = Date.parse(`${row.diary_judged_at.replace(' ', 'T')}Z`)
          if (!Number.isNaN(judged) && lastActive <= judged) continue
        }
        if (await this.flush(row.id)) written += 1
      }
    } catch {
      return written
    }
    return written
  }

  dispose(): void {
    for (const handle of this.timers.values()) this.scheduler.clear(handle)
    this.timers.clear()
    this.disposed = true
  }

  private cancel(sessionId: string): void {
    const handle = this.timers.get(sessionId)
    if (handle === undefined) return
    this.scheduler.clear(handle)
    this.timers.delete(sessionId)
  }
}
