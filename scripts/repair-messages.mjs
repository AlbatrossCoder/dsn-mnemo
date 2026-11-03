/**
 * Repair historical L0 rows.
 *
 *   node scripts/repair-messages.mjs [dbPath] [--keep-reasoning]
 *
 * - recomputes `content`/`content_seg` with the current flatten rules (tool-call
 *   arguments are no longer searchable);
 * - strips reasoning blocks from the stored raw JSON unless `--keep-reasoning`;
 * - rebuilds both FTS indexes and vacuums a backup first.
 *
 * Pass `--dry-run` to only report what would change.
 */
import { openDatabase, rebuildIndexes, resolveDbPath } from '../lib/db/database.js'
import { flattenContent } from '../lib/session/flatten.js'
import { segment } from '../lib/db/segment.js'

const args = process.argv.slice(2)
const keepReasoning = args.includes('--keep-reasoning')
const dryRun = args.includes('--dry-run')
const dbPath = args.find((arg) => !arg.startsWith('--')) ?? '~/.dsh/mnemo/mnemo.db'

const db = openDatabase(dbPath)
const file = resolveDbPath(dbPath)

if (!dryRun) {
  const backup = `${file}.backup-${Date.now()}`
  db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`)
  console.log(`backup: ${backup}`)
}

const rows = db.prepare('select id, content, raw from messages').all()
let changed = 0
let reasoningStripped = 0

const update = db.prepare('update messages set content = ?, content_seg = ?, raw = ? where id = ?')

db.exec('begin immediate')
try {
  for (const row of rows) {
    let message
    try {
      message = JSON.parse(row.raw)
    } catch {
      continue
    }
    const blocks = Array.isArray(message.content) ? message.content : []
    const content = flattenContent(blocks)
    let raw = row.raw
    if (!keepReasoning) {
      const filtered = blocks.filter((block) => block?.type !== 'reasoning')
      if (filtered.length !== blocks.length) {
        reasoningStripped += 1
        message = { ...message, content: filtered }
        raw = JSON.stringify(message)
      }
    }
    if (content !== row.content || raw !== row.raw) {
      changed += 1
      if (!dryRun) update.run(content, segment(content), raw, row.id)
    }
  }
  if (!dryRun) db.exec('commit')
  else db.exec('rollback')
} catch (error) {
  db.exec('rollback')
  throw error
}

if (!dryRun) rebuildIndexes(db)
console.log(`rows: ${rows.length}, changed: ${changed}, reasoning stripped: ${reasoningStripped}${dryRun ? ' (dry run)' : ''}`)
db.close()
