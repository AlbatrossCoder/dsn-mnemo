/**
 * L2 relationship stage.
 *
 * The stage is driven by accumulated presence, not by turn count: every
 * session counts once, every diary half. It is recomputed after each turn and
 * stored on the session row, so it survives restarts.
 *
 * @module dsn-mnemo/store/relation
 */
import type { DatabaseSync } from 'node:sqlite'

export type RelationStage = 'initial' | 'familiar' | 'close'

/** `sessions_count + diary_count × 0.5`. */
export function relationScore(sessionCount: number, diaryCount: number): number {
  return sessionCount + diaryCount * 0.5
}

/** Map a score onto the three stages. */
export function stageForScore(score: number): RelationStage {
  if (score < 5) return 'initial'
  if (score < 20) return 'familiar'
  return 'close'
}

/** Recompute and persist one session's stage; returns the new stage. */
export function refreshRelationStage(db: DatabaseSync, sessionId: string): RelationStage {
  const sessions = (db.prepare('select count(*) as total from sessions').get() as { total: number }).total
  const diaries = (db.prepare('select count(*) as total from diaries').get() as { total: number }).total
  const stage = stageForScore(relationScore(sessions, diaries))
  db.prepare('update sessions set relation_stage = ? where id = ?').run(stage, sessionId)
  return stage
}
