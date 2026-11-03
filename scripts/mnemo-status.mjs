/**
 * Print what the memory runtime currently holds.
 *
 *   node scripts/mnemo-status.mjs [dbPath]
 *
 * Defaults to the plugin's default path (`~/.dsh/mnemo/mnemo.db`). Opening
 * applies pending migrations, so this also repairs an older dev database.
 */
import { openDatabase, resolveDbPath, schemaVersion } from '../lib/db/database.js'

const dbPath = process.argv[2] ?? '~/.dsh/mnemo/mnemo.db'
const db = openDatabase(dbPath)

const count = (table) => db.prepare(`select count(*) as total from ${table}`).get().total

console.log(`db:        ${resolveDbPath(dbPath)}`)
console.log(`schema:    v${schemaVersion(db)}`)
console.log(`sessions:  ${count('sessions')}`)
console.log(`messages:  ${count('messages')} (L0)`)
console.log(`diaries:   ${count('diaries')} (L1)`)
console.log(`anchors:   ${count('anchors')} (L3)`)

const sessions = db
  .prepare(
    `select id, turn_count, relation_stage, last_active_at, diary_judged_at
       from sessions order by last_active_at desc limit 5`,
  )
  .all()
if (sessions.length > 0) {
  console.log('\nsessions:')
  for (const row of sessions) {
    console.log(
      `  ${row.id} turns=${row.turn_count} stage=${row.relation_stage} active=${row.last_active_at} judged=${row.diary_judged_at ?? '-'}`,
    )
  }
}

const recent = db
  .prepare(
    `select session_id, turn, role, substr(content, 1, 60) as preview, created_at
       from messages order by id desc limit 5`,
  )
  .all()
if (recent.length > 0) {
  console.log('\nrecent messages:')
  for (const row of recent.reverse()) {
    console.log(`  [${row.created_at}] ${row.session_id}#${row.turn} ${row.role}: ${row.preview}`)
  }
}

const diaryRows = db
  .prepare('select id, importance, emotion, substr(content, 1, 60) as preview, created_at from diaries order by id desc limit 3')
  .all()
if (diaryRows.length > 0) {
  console.log('\nrecent diaries:')
  for (const row of diaryRows.reverse()) {
    console.log(`  #${row.id} [${row.created_at}] i=${row.importance} e=${row.emotion} ${row.preview}`)
  }
}

db.close()
