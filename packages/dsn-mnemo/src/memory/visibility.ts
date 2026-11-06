/**
 * Owner-aware read rules.
 *
 * Writes still land on the original subject. Reads are a union that depends on
 * the scene the whale is standing in:
 *
 * - 群：只读本群 `public` 日记，以及本群会话。任何 `user:*` 都不可见。
 * - 非主人私聊：自己的日记（含 secret）+ 所有群的 public 日记 + 其他普通人的日记
 *   （排除主人、`local`，跨主体时排除 secret）。原文日志只含自己的私聊和群会话。
 * - 主人私聊：在上面的并集上，再加上主人自己的日记（含 secret）。
 *
 * @module dsn-mnemo/memory/visibility
 */
import { readFileSync } from 'node:fs'
import { expandHome } from '../db/database.js'

export interface MemoryScene {
  readonly kind: 'user' | 'group'
  readonly id: string
}

/** Who is speaking, and who the owner is (empty when unknown). */
export interface MemoryAccess {
  readonly scene: MemoryScene
  readonly ownerId: string
}

export interface DiaryRef {
  readonly subjectKind: string | null
  readonly subjectId: string | null
  readonly visibility: string
}

export interface SessionRef {
  readonly kind: 'dm' | 'group'
  readonly audienceId: string
}

export function isMemoryAccess(value: object): value is MemoryAccess {
  return 'scene' in value && typeof value.scene === 'object' && value.scene !== null
}

export function buildMemoryAccess(scene: MemoryScene, ownerId: string): MemoryAccess {
  return { scene, ownerId: ownerId.trim() }
}

/** Configured id wins; an explicit state file is the fallback. Missing file → ''. */
export function resolveOwnerId(options: { ownerId?: string; statePath?: string } = {}): string {
  const configured = options.ownerId?.trim() ?? ''
  if (configured.length > 0) return configured
  if (options.statePath === undefined || options.statePath.trim().length === 0) return ''
  return ownerFromFile(expandHome(options.statePath))
}

function ownerFromFile(path: string): string {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { ownerId?: unknown }
    return typeof parsed.ownerId === 'string' ? parsed.ownerId.trim() : ''
  } catch {
    return ''
  }
}

function isOwnUser(access: MemoryAccess, diary: DiaryRef): boolean {
  return diary.subjectKind === 'user' && diary.subjectId === access.scene.id
}

/**
 * Whether this diary may be read in the current scene.
 * Group private/secret rows are not part of any read set.
 */
export function diaryVisible(access: MemoryAccess, diary: DiaryRef): boolean {
  if (access.scene.kind === 'group') {
    return diary.subjectKind === 'group' && diary.subjectId === access.scene.id && diary.visibility === 'public'
  }
  if (isOwnUser(access, diary)) return true
  if (diary.subjectKind === 'group') return diary.visibility === 'public'
  if (diary.subjectKind !== 'user' || diary.subjectId === null || diary.subjectId.length === 0) return false
  if (diary.subjectId === 'local') return false
  if (access.ownerId.length > 0 && diary.subjectId === access.ownerId) return false
  return diary.visibility !== 'secret'
}

/**
 * Whether this session's transcript may be searched.
 * Private chats never include another person's DM log. Group scenes never
 * include any DM log.
 */
export function sessionVisible(access: MemoryAccess, session: SessionRef): boolean {
  const audience = session.audienceId.length === 0 ? 'local' : session.audienceId
  if (access.scene.kind === 'group') {
    return session.kind === 'group' && audience === access.scene.id
  }
  if (session.kind === 'group') return true
  return audience === access.scene.id
}

/** SQL fragment (`and ...`) matching {@link diaryVisible}. `alias` is `''` or `'d.'`. */
export function diaryAccessClause(access: MemoryAccess, alias = ''): { sql: string; params: string[] } {
  const kind = `${alias}subject_kind`
  const id = `${alias}subject_id`
  const visibility = `${alias}visibility`
  if (access.scene.kind === 'group') {
    return {
      sql: `and ${kind} = 'group' and ${id} = ? and ${visibility} = 'public'`,
      params: [access.scene.id],
    }
  }
  const params = [access.scene.id, access.scene.id, access.ownerId, access.ownerId]
  return {
    sql: `and (
      (${kind} = 'user' and ${id} = ?)
      or (${kind} = 'group' and ${visibility} = 'public')
      or (
        ${kind} = 'user'
        and ${id} != 'local'
        and ${id} != ?
        and ${visibility} != 'secret'
        and (? = '' or ${id} != ?)
      )
    )`,
    params,
  }
}

/** SQL fragment (`and ...`) matching {@link sessionVisible}. Sessions are aliased `s`. */
export function sessionAccessClause(access: MemoryAccess): { sql: string; params: string[] } {
  if (access.scene.kind === 'group') {
    return { sql: "and s.kind = 'group' and s.audience_id = ?", params: [access.scene.id] }
  }
  return {
    sql: "and (s.kind = 'group' or (s.kind = 'dm' and coalesce(s.audience_id, 'local') = ?))",
    params: [access.scene.id],
  }
}
