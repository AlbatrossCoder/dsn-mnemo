/**
 * The `mnemo_forget` tool: erase every memory that belongs to one subject.
 *
 * Deleting a person's or a group's memory removes L0 messages (and the
 * sessions that hold them), diaries, anchors, portraits, mind state, bonds,
 * the subject ledger, and the `persons` row. It is the only supported way to
 * "forget me".
 *
 * @module dsn-mnemo/tools/forget
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DatabaseSync } from 'node:sqlite'
import { deletePortraitsForGroup, deletePortraitsForUser } from '../store/portrait-store.js'

interface ForgotCounts {
  messages: number
  sessions: number
  diaries: number
  anchors: number
  persons: number
  portraits: number
  mindStates: number
  bonds: number
  ledger: number
}

function forget(db: DatabaseSync, kind: 'user' | 'group', id: string): ForgotCounts {
  const sessionKind = kind === 'group' ? 'group' : 'dm'
  db.exec('begin immediate')
  try {
    const sessions = db
      .prepare('select id from sessions where kind = ? and audience_id = ?')
      .all(sessionKind, id) as Array<{ id: string }>
    const sessionIds = sessions.map((row) => row.id)

    const counts: ForgotCounts = {
      messages: 0,
      sessions: 0,
      diaries: 0,
      anchors: 0,
      persons: 0,
      portraits: 0,
      mindStates: 0,
      bonds: 0,
      ledger: 0,
    }

    for (const sessionId of sessionIds) {
      counts.messages += Number(db.prepare('delete from messages where session_id = ?').run(sessionId).changes)
    }
    counts.diaries = Number(
      db.prepare('delete from diaries where subject_kind = ? and subject_id = ?').run(kind, id).changes,
    )
    counts.anchors = Number(
      db.prepare('delete from anchors where subject_kind = ? and subject_id = ?').run(kind, id).changes,
    )
    counts.mindStates = Number(
      db.prepare('delete from mind_states where subject_kind = ? and subject_id = ?').run(kind, id).changes,
    )
    counts.bonds = Number(
      db.prepare('delete from bonds where subject_kind = ? and subject_id = ?').run(kind, id).changes,
    )
    counts.ledger = Number(
      db.prepare('delete from subject_ledger where subject_kind = ? and subject_id = ?').run(kind, id).changes,
    )
    if (kind === 'user') {
      counts.persons = Number(db.prepare('delete from persons where user_id = ?').run(id).changes)
      counts.portraits = deletePortraitsForUser(db, id)
    } else {
      counts.portraits = deletePortraitsForGroup(db, id)
    }
    for (const sessionId of sessionIds) {
      counts.sessions += Number(db.prepare('delete from sessions where id = ?').run(sessionId).changes)
    }
    db.exec('commit')
    return counts
  } catch (error) {
    db.exec('rollback')
    throw error
  }
}

/** Build the registry-ready `mnemo_forget` tool bound to one database. */
export function createForgetTool(db: DatabaseSync) {
  return defineTool({
    name: 'mnemo_forget',
    description:
      'Erase all memory of one person or one group (chat log, diaries, anchors, person profile). Use only when the user explicitly asks to be forgotten.',
    parameters: {
      subject_kind: {
        type: 'string',
        enum: ['user', 'group'],
        description: 'user = one person, group = one group chat.',
        required: true,
      },
      subject_id: {
        type: 'string',
        description: 'The QQ id of the person, or the group id.',
        required: true,
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          messages: { type: 'number' },
          sessions: { type: 'number' },
          diaries: { type: 'number' },
          anchors: { type: 'number' },
          persons: { type: 'number' },
          portraits: { type: 'number' },
          mindStates: { type: 'number' },
          bonds: { type: 'number' },
          ledger: { type: 'number' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `forgot: ${value.messages} messages, ${value.diaries} diaries, ${value.anchors} anchors`,
        },
      ],
    },
    async execute(args) {
      return forget(db, args.subject_kind as 'user' | 'group', args.subject_id)
    },
  })
}
