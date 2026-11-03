/**
 * The `diary_consolidate` tool: run the diary judgement right now.
 *
 * The idle timer is the normal trigger; this tool exists for the explicit
 * case ("把刚才聊的记下来") and as a way to verify the judgement path without
 * waiting thirty minutes.
 *
 * @module dsn-mnemo/tools/diary-consolidate
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DatabaseSync } from 'node:sqlite'

export interface ConsolidateHost {
  /** Run the diary judgement for one session; resolves whether a diary was written. */
  flush(sessionId: string): Promise<boolean>
}

/** Build the registry-ready `diary_consolidate` tool. */
export function createConsolidateTool(db: DatabaseSync, host: ConsolidateHost) {
  return defineTool({
    name: 'diary_consolidate',
    description:
      'Run the diary judgement for the current session immediately instead of waiting for the idle timer. Use it when the user explicitly asks to remember this conversation now.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          written: { type: 'boolean' },
          diary_id: { type: 'number' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.written ? `diary #${value.diary_id} written` : 'no diary was worth writing',
        },
      ],
    },
    async execute(_args, exec) {
      const sessionId = exec.agent?.session.id
      if (sessionId === undefined) throw new Error('diary_consolidate needs a live agent session')
      const written = await host.flush(sessionId)
      if (!written) return { written: false }
      const row = db.prepare('select id from diaries where session_id = ? order by id desc limit 1').get(sessionId) as
        | { id: number }
        | undefined
      return row === undefined ? { written: true } : { written: true, diary_id: row.id }
    },
  })
}
