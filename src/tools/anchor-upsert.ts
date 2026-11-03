/**
 * The `anchor_upsert` tool: let the model (or the user, through the model)
 * record a date that should come up on its own later.
 *
 * @module dsn-mnemo/tools/anchor-upsert
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DatabaseSync } from 'node:sqlite'
import { upsertAnchor, type Repeat } from '../store/anchor-store.js'
import { sessionSubject } from '../store/message-store.js'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Reject dates the calendar does not have, such as `2026-02-31`. */
function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** Build the registry-ready `anchor_upsert` tool bound to one database. */
export function createAnchorTool(db: DatabaseSync) {
  return defineTool({
    name: 'anchor_upsert',
    description:
      'Record a date worth remembering later, such as an anniversary, a promised meeting, or a deadline, so it can surface near that day. Use it only for dates the user actually stated.',
    parameters: {
      event_name: {
        type: 'string',
        description: 'Short name of the event, e.g. 一起看海.',
        required: true,
      },
      target_date: {
        type: 'string',
        description: 'Calendar date in YYYY-MM-DD.',
        required: true,
      },
      window_days: {
        type: 'integer',
        description: 'How many days before and after the date it should surface. Defaults to the plugin setting.',
      },
      tone_hint: {
        type: 'string',
        description: 'Optional note on how to bring it up.',
      },
      repeat: {
        type: 'string',
        enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'],
        description:
          'Recurrence stated by the user, e.g. weekly for 每周六开黑. The memory system stores it as given and never infers it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          event_name: { type: 'string' },
          target_date: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `anchor #${value.id}: ${value.target_date} ${value.event_name}` },
      ],
    },
    async execute(args, exec) {
      if (!isRealDate(args.target_date)) {
        throw new Error(`target_date must be a real calendar date in YYYY-MM-DD, got: ${args.target_date}`)
      }
      const sessionId = exec.agent?.session.id
      const subject = sessionId === undefined ? { kind: 'user' as const, id: 'local' } : sessionSubject(db, sessionId)
      const id = upsertAnchor(db, {
        eventName: args.event_name,
        targetDate: args.target_date,
        subject,
        windowDays: args.window_days ?? null,
        toneHint: args.tone_hint ?? null,
        repeat: (args.repeat as Repeat | undefined) ?? 'none',
      })
      return { id, event_name: args.event_name, target_date: args.target_date }
    },
  })
}
