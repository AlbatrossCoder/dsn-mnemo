/**
 * Manual diary tools.
 *
 * `diary_write` lets the model keep something deliberately; `diary_update` is
 * the only way an existing diary may change, and it always stores the previous
 * text plus the stated reason first.
 *
 * @module dsn-mnemo/tools/diary-write
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DatabaseSync } from 'node:sqlite'
import { segment } from '../db/segment.js'
import { insertDiary } from '../store/diary-store.js'
import { sessionSubject } from '../store/message-store.js'

interface ExistingDiary {
  id: number
  content: string
}

/** Build the registry-ready `diary_write` tool bound to one database. */
export function createDiaryWriteTool(db: DatabaseSync) {
  return defineTool({
    name: 'diary_write',
    description:
      '像写日记一样，把这一轮里值得记住的内容记下来——做了什么、吃了什么、去了哪里、聊了什么、做了什么决定，日常流水账也算；记什么、写多长由你判断，没有条数限制。',
    parameters: {
      content: {
        type: 'string',
        description: 'The diary body, first person.',
        required: true,
      },
      importance: {
        type: 'number',
        description: 'How important this is, 0-1. Defaults to 0.5.',
      },
      emotion: {
        type: 'number',
        description: 'Emotional intensity, 0-1. Defaults to 0.5.',
      },
      tags: {
        type: 'string',
        description: 'Comma-separated tags, e.g. 日常,约定.',
      },
      visibility: {
        type: 'string',
        enum: ['public', 'private', 'secret'],
        description:
          'Visibility. Defaults to public in a group, private in a 1:1 chat. Mark secret for something that must never appear in a group.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { id: { type: 'number' } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `diary #${value.id} written` }],
    },
    async execute(args, exec) {
      const tags = (args.tags ?? '')
        .split(/[,，、\s]+/)
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
        .slice(0, 3)
      const sessionId = exec.agent?.session.id
      const subject = sessionId === undefined ? undefined : sessionSubject(db, sessionId)
      const visibility =
        args.visibility === 'public' || args.visibility === 'private' || args.visibility === 'secret'
          ? args.visibility
          : subject?.kind === 'group'
            ? 'public'
            : 'private'
      const id = insertDiary(db, {
        sessionId: sessionId ?? null,
        subjectKind: subject?.kind ?? null,
        subjectId: subject?.id ?? null,
        visibility,
        content: args.content,
        importance: clamp(args.importance),
        emotion: clamp(args.emotion),
        typeTags: tags,
      })
      return { id }
    },
  })
}

/** Build the registry-ready `diary_update` tool bound to one database. */
export function createDiaryUpdateTool(db: DatabaseSync) {
  return defineTool({
    name: 'diary_update',
    description:
      'Correct an existing diary. Only use this when the user explicitly corrects a fact, or when a recorded anchor contradicts the diary. Always state the reason; the previous text is backed up automatically.',
    parameters: {
      id: {
        type: 'integer',
        description: 'Diary id to rewrite.',
        required: true,
      },
      content: {
        type: 'string',
        description: 'The corrected diary body.',
        required: true,
      },
      reason: {
        type: 'string',
        description: 'Why the stored text is wrong; required.',
        required: true,
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { id: { type: 'number' }, revision: { type: 'number' } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `diary #${value.id} updated (revision ${value.revision})` }],
    },
    async execute(args) {
      const reason = args.reason.trim()
      if (reason.length < 4) throw new Error('reason must explain the correction (at least 4 characters)')
      const content = args.content.trim()
      if (content.length < 4) throw new Error('content is too short to be a diary')

      const existing = db.prepare('select id, content from diaries where id = ?').get(args.id) as
        | ExistingDiary
        | undefined
      if (existing === undefined) throw new Error(`diary ${args.id} not found`)

      const revision = db
        .prepare('insert into diary_revisions(diary_id, content, reason) values (?, ?, ?)')
        .run(existing.id, existing.content, reason)
      db.prepare("update diaries set content = ?, content_seg = ?, updated_at = datetime('now') where id = ?").run(
        content,
        segment(content),
        existing.id,
      )
      return { id: existing.id, revision: Number(revision.lastInsertRowid) }
    },
  })
}

function clamp(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}
