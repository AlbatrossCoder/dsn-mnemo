/**
 * Print what the memory runtime currently holds.
 *
 *   node scripts/mnemo-status.mjs [dbPath]
 *
 * Defaults to the plugin's default path (`~/.dsh/mnemo/mnemo.db`). Opening
 * applies pending migrations, so this also repairs an older dev database.
 */
import { openDatabase, resolveDbPath } from '../lib/db/database.js'

const dbPath = process.argv[2] ?? '~/.dsh/mnemo/mnemo.db'
const db = openDatabase(dbPath)

const count = (table) => db.prepare(`select count(*) as total from ${table}`).get().total

console.log(`db: ${resolveDbPath(dbPath)}`)
console.log(`sessions: ${count('sessions')}`)
console.log(`messages (L0): ${count('messages')}`)
console.log(`diaries (L1): ${count('diaries')}`)
console.log(`anchors (L3): ${count('anchors')}`)

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

db.close()
