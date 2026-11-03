/**
 * Repair historical L0 rows.
 *
 *   node scripts/repair-messages.mjs [dbPath] [--keep-reasoning] [--keep-tools] [--dry-run]
 *
 * L0 now stores chat only (human prompts + assistant visible replies). This
 * script brings an older database in line:
 *
 * - recomputes `content`/`content_seg` with the current flatten rules;
 * - strips reasoning blocks from the stored raw JSON unless `--keep-reasoning`;
 * - deletes tool-role rows and assistant rows that flatten to no text unless
 *   `--keep-tools`;
 * - rewrites raw JSON (reasoning stripped) and rebuilds both FTS indexes;
 * - writes a `VACUUM INTO` backup before touching anything.
 */
import { openDatabase, rebuildIndexes, resolveDbPath } from '../lib/db/database.js'
import { flattenContent } from '../lib/session/flatten.js'
import { segment } from '../lib/db/segment.js'

const args = process.argv.slice(2)
const keepReasoning = args.includes('--keep-reasoning')
const keepTools = args.includes('--keep-tools')
const dryRun = args.includes('--dry-run')
const dbPath = args.find((arg) => !arg.startsWith('--')) ?? '~/.dsh/mnemo/mnemo.db'

const db = openDatabase(dbPath)
const file = resolveDbPath(dbPath)

if (!dryRun) {
  const backup = `${file}.backup-${Date.now()}`
  db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`)
  console.log(`backup: ${backup}`)
}

const rows = db.prepare('select id, role, content, raw from messages').all()
let changed = 0
let deleted = 0
let reasoningStripped = 0

const update = db.prepare('update messages set content = ?, content_seg = ?, raw = ? where id = ?')
const remove = db.prepare('delete from messages where id = ?')

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

    // Tool results are not conversation; injected user-role context (time,
    // goal rounds, runtime snapshots) is not a human prompt either.
    const injected = row.role === 'user' && message.source?.kind !== 'user'
    const notConversation = row.role === 'tool' || injected || content.trim().length === 0
    if (notConversation) {
      if (!keepTools) {
        deleted += 1
        if (!dryRun) remove.run(row.id)
        continue
      }
    }

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
console.log(
  `rows: ${rows.length}, updated: ${changed}, deleted: ${deleted}, reasoning stripped: ${reasoningStripped}${dryRun ? ' (dry run)' : ''}`,
)
db.close()
