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
  /** Judged turns since the last attempt that force an immediate judgement. */
  readonly maxTurns?: number
  /** Judged characters since the last attempt that force an immediate judgement. */
  readonly maxChars?: number
  /** Run the judgement immediately when the latest turn looks important. */
  readonly immediateOnImportant?: boolean
  readonly personaHint?: string
  readonly scheduler?: Scheduler
  readonly now?: () => Date
  /** Observes judgement failures; the engine never throws them upward. */
  readonly onError?: (error: unknown) => void
  /** Optional diagnostic trace, e.g. a file logger enabled by config. */
  readonly log?: (message: string) => void
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
const DEFAULT_MAX_TURNS = 30
const DEFAULT_MAX_CHARS = 12_000

/**
 * Cues that a turn carries something worth remembering *now* rather than
 * after the idle window. Deliberately narrow: a false positive costs one
 * short model call, a false negative just falls back to the other triggers.
 */
const IMPORTANT_CUES =
  /生日|纪念日|约定|答应|承诺|第一次|最后一次|再也不|分手|离开|去世|结婚|怀孕|生病|住院|吵架|和好|道歉|难过|哭|想你|喜欢你|害怕|孤独|重要|决定|辞职|搬家|考试|面试|录取|礼物|惊喜/

export class DiaryEngine {
  private readonly timers = new Map<string, unknown>()
  private readonly running = new Set<string>()
  private readonly scheduler: Scheduler
  private disposed = false

  constructor(private readonly options: DiaryEngineOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler
  }

  /**
   * Called when a turn completes.
   *
   * Three triggers, checked in order:
   * 1. the latest turn contains an "important" cue → judge immediately;
   * 2. the conversation since the last judgement is long enough → judge now;
   * 3. otherwise arm the idle timer.
   */
  noteTurnEnd(sessionId: string): void {
    if (this.disposed) return
    this.cancel(sessionId)

    if (this.options.immediateOnImportant !== false && this.hasImportantCue(sessionId)) {
      this.options.log?.(`trigger=important session=${sessionId}`)
      void this.flush(sessionId)
      return
    }
    if (this.isLongEnough(sessionId)) {
      this.options.log?.(`trigger=length session=${sessionId}`)
      void this.flush(sessionId)
      return
    }

    const handle = this.scheduler.set(() => {
      this.timers.delete(sessionId)
      this.options.log?.(`trigger=idle session=${sessionId}`)
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

  /** Messages recorded since the last judgement attempt. */
  private recentSinceJudge(sessionId: string): { turns: number; chars: number; text: string } {
    const db = this.options.db
    const session = db.prepare('select diary_judged_at from sessions where id = ?').get(sessionId) as
      | { diary_judged_at: string | null }
      | undefined
    const since = session?.diary_judged_at ?? '1970-01-01 00:00:00'
    const rows = db
      .prepare('select role, content from messages where session_id = ? and created_at > ? order by id')
      .all(sessionId, since) as unknown as MessageRow[]
    return {
      turns: rows.filter((row) => row.role === 'user').length,
      chars: rows.reduce((sum, row) => sum + row.content.length, 0),
      text: rows.map((row) => row.content).join('\n'),
    }
  }

  private hasImportantCue(sessionId: string): boolean {
    return IMPORTANT_CUES.test(this.recentSinceJudge(sessionId).text)
  }

  private isLongEnough(sessionId: string): boolean {
    const { turns, chars } = this.recentSinceJudge(sessionId)
    const maxTurns = this.options.maxTurns ?? DEFAULT_MAX_TURNS
    const maxChars = this.options.maxChars ?? DEFAULT_MAX_CHARS
    return turns >= maxTurns || chars >= maxChars
  }

  /**
   * Judge and (maybe) write one session's diary now.
   *
   * @returns whether a diary was written.
   */
  async flush(sessionId: string): Promise<boolean> {
    const { db } = this.options
    this.options.log?.(`flush session=${sessionId}`)
    // One judgement at a time per session: the idle timer and a length
    // trigger can fire close together.
    if (this.running.has(sessionId)) return false
    this.running.add(sessionId)
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
      this.options.log?.(`judged session=${sessionId} chars=${transcript.length} written=${decision !== null}`)
      if (decision === null) return false

      insertDiary(db, {
        sessionId,
        content: decision.content,
        importance: decision.importance,
        emotion: decision.emotion,
        typeTags: decision.tags,
      })
      return true
    } catch (error) {
      // A failed judgement must never surface to the conversation.
      this.options.onError?.(error)
      return false
    } finally {
      this.running.delete(sessionId)
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
