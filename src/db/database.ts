/**
 * Connection lifecycle: path resolution, pragmas, migrations, index rebuild.
 *
 * @module dsn-mnemo/db/database
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js'

/** Sentinel accepted by {@link openDatabase} for an ephemeral database. */
export const MEMORY_DB = ':memory:'

/** Expand a leading `~` to the current user's home directory. */
export function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2))
  return input
}

/** Resolve a configured `dbPath` into an absolute file path (or `:memory:`). */
export function resolveDbPath(input: string): string {
  if (input === MEMORY_DB) return MEMORY_DB
  const expanded = expandHome(input)
  return isAbsolute(expanded) ? expanded : resolve(expanded)
}

/** Read the applied migration count. */
export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('pragma user_version').get() as { user_version?: number } | undefined
  return row?.user_version ?? 0
}

/**
 * Apply every pending migration in order.
 *
 * Each step runs in its own transaction together with the `user_version`
 * bump, so a crash leaves the database at the last fully applied version.
 *
 * @returns the schema version after migrating.
 */
export function migrate(db: DatabaseSync): number {
  const from = schemaVersion(db)
  for (let version = from; version < MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version]
    if (sql === undefined) continue
    db.exec('begin immediate')
    try {
      db.exec(sql)
      db.exec(`pragma user_version = ${version + 1}`)
      db.exec('commit')
    } catch (error) {
      db.exec('rollback')
      throw error
    }
  }
  return schemaVersion(db)
}

/**
 * Open (and migrate) the memory database.
 *
 * WAL keeps readers from blocking the diary writer; `busy_timeout` absorbs the
 * short lock windows Windows cannot avoid. Foreign keys stay on so deleting a
 * session cannot orphan its messages.
 */
export function openDatabase(path: string): DatabaseSync {
  const file = resolveDbPath(path)
  if (file !== MEMORY_DB) mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('pragma journal_mode = wal')
  db.exec('pragma foreign_keys = on')
  db.exec('pragma busy_timeout = 5000')
  db.exec('pragma synchronous = normal')
  migrate(db)
  return db
}

/**
 * Rebuild both FTS indexes from the authoritative `*_seg` columns.
 *
 * This is the only supported way to repair an index: the external-content
 * tables cannot rebuild themselves, because the main tables store unsegmented
 * text in `content`.
 */
export function rebuildIndexes(db: DatabaseSync): void {
  db.exec('begin immediate')
  try {
    db.exec("insert into messages_fts(messages_fts) values ('delete-all')")
    db.exec('insert into messages_fts(rowid, content) select id, content_seg from messages')
    db.exec("insert into diaries_fts(diaries_fts) values ('delete-all')")
    db.exec('insert into diaries_fts(rowid, content) select id, content_seg from diaries')
    db.exec("insert into memory_points_fts(memory_points_fts) values ('delete-all')")
    db.exec('insert into memory_points_fts(rowid, text) select id, content_seg from memory_points')
    db.exec('commit')
  } catch (error) {
    db.exec('rollback')
    throw error
  }
}

/** Latest supported schema version (mirrors the migration list length). */
export { SCHEMA_VERSION }
