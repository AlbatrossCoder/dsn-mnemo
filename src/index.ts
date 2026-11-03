import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { openDatabase } from './db/database.js'
import { createProactiveText } from './inject/proactive.js'
import { formatDate, renderStablePrefix } from './inject/stable-prefix.js'
import { SessionRecorder } from './session/recorder.js'
import { anchorsInWindow } from './store/anchor-store.js'
import { createAnchorTool } from './tools/anchor-upsert.js'
import { createRecallTool } from './tools/recall.js'

/** Cordis plugin name; must stay stable so profile entries can target it. */
export const name = 'mnemo'

/**
 * Services required before `apply` runs. `systemPrompt` owns the cached stable
 * prefix, `sessions` supplies the L0 event stream, `tools` is the registry.
 */
export const inject = ['tools', 'sessions', 'systemPrompt']

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

const VERSION = '0.4.0'

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

  // Stable prefix: rules + anchors inside today's window. Everything here is
  // deterministic for a given day, so the cached request prefix stays intact.
  ctx.systemPrompt.section({
    name: 'mnemo:rules',
    order: 30,
    interpolate: false,
    text: () => {
      const today = formatDate(new Date())
      return renderStablePrefix(anchorsInWindow(db, today, config.anchorWindowDays), today)
    },
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
  ctx.tools.register(createAnchorTool(db))

  // Dynamic context: one contribution per live agent, so the text can be
  // derived from that agent's own latest human message. It is replaced every
  // turn (never accumulated) and lives outside the cached stable prefix.
  const proactive = createProactiveText(db, { limit: config.contextRecallLimit })
  ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    agent.ctx.systemPrompt.context({
      name: 'mnemo:recall',
      order: 40,
      interpolate: false,
      text: () => proactive(agent.session),
    })
  })
}
