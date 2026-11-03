import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { openDatabase } from './db/database.js'
import { SessionRecorder } from './session/recorder.js'
import { createRecallTool } from './tools/recall.js'

/** Cordis plugin name; must stay stable so profile entries can target it. */
export const name = 'mnemo'

/**
 * Services required before `apply` runs. `sessions` supplies the event stream
 * that feeds L0; `tools` is the registry `recall` and `mnemo_ping` join.
 */
export const inject = ['tools', 'sessions']

/** User-facing configuration (mirrors DESIGN.md §8). */
export const Config = z.object({
  dbPath: z.string().default('~/.dsh/mnemo/mnemo.db'),
  diaryIdleMinutes: z.natural().default(30),
  diaryMaxPerSession: z.natural().default(3),
  anchorWindowDays: z.natural().default(2),
  contextRecallLimit: z.natural().default(3),
  recallDiaryLimit: z.natural().default(5),
  recallLogLimit: z.natural().default(5),
})

export type MnemoConfig = Schemastery.TypeT<typeof Config>

const VERSION = '0.2.0'

/**
 * Mount the memory runtime.
 *
 * Opening the database happens before registration so a broken path fails
 * loudly at load time instead of silently degrading every later write.
 * No `export default`: the loader's unwrapExports would drop `inject`.
 */
export function apply(ctx: Context, config: MnemoConfig) {
  const db = openDatabase(config.dbPath)
  const recorder = new SessionRecorder(db)

  ctx.effect(() => () => {
    db.close()
  })

  ctx.on('session/event', (session, event: SessionEvent) => {
    recorder.handle(session, event)
  })

  const ping = defineTool({
    name: 'mnemo_ping',
    description:
      'Health check for the mnemo memory plugin. Returns the plugin version and the configured database path.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          pong: { type: 'boolean' },
          version: { type: 'string' },
          dbPath: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `mnemo ${value.version} ok (${value.dbPath})` }],
    },
    async execute() {
      return { pong: true, version: VERSION, dbPath: config.dbPath }
    },
  })

  ctx.tools.register(ping)
  ctx.tools.register(
    createRecallTool(db, {
      diaryLimit: config.recallDiaryLimit,
      logLimit: config.recallLogLimit,
    }),
  )
}
