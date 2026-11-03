import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { openDatabase, MEMORY_DB, resolveDbPath } from './db/database.js'
import { DiaryEngine } from './diary/engine.js'
import { createProactiveText } from './inject/proactive.js'
import { formatDate, renderStablePrefix } from './inject/stable-prefix.js'
import { SessionRecorder } from './session/recorder.js'
import { anchorsInWindow } from './store/anchor-store.js'
import { refreshRelationStage } from './store/relation.js'
import { createAnchorTool } from './tools/anchor-upsert.js'
import { createConsolidateTool } from './tools/diary-consolidate.js'
import { createDiaryUpdateTool, createDiaryWriteTool } from './tools/diary-write.js'
import { createRecallTool } from './tools/recall.js'

/** Cordis plugin name; must stay stable so profile entries can target it. */
export const name = 'mnemo'

/**
 * Services required before `apply` runs. `systemPrompt` owns the cached stable
 * prefix, `sessions` supplies the L0 event stream, `llm` runs the diary
 * judgement, `tools` is the registry.
 */
export const inject = ['tools', 'sessions', 'systemPrompt', 'llm']

/** User-facing configuration (mirrors DESIGN.md §8). */
export const Config = z.object({
  dbPath: z.string().default('~/.dsh/mnemo/mnemo.db'),
  diaryIdleMinutes: z.natural().min(5).max(1440).default(20),
  diaryMaxPerSession: z.natural().default(3),
  diaryProvider: z.string().default('deepseek-account'),
  diaryModel: z.string().default('deepseek-flash'),
  diaryPersonaHint: z.string().default(''),
  diaryDebug: z.boolean().default(false),
  anchorWindowDays: z.natural().default(2),
  contextRecallLimit: z.natural().default(3),
  recallDiaryLimit: z.natural().default(5),
  recallLogLimit: z.natural().default(5),
})

export type MnemoConfig = Schemastery.TypeT<typeof Config>

const VERSION = '0.6.4'

/**
 * Optional diary trace, enabled by `diaryDebug`. It sits next to the database
 * so a user can find it, and it is best-effort: diagnostics never throw.
 */
function createDiaryLogger(dbPath: string): ((message: string) => void) | undefined {
  const file = resolveDbPath(dbPath)
  if (file === MEMORY_DB) return undefined
  const target = join(dirname(file), 'diary.log')
  return (message) => {
    try {
      mkdirSync(dirname(target), { recursive: true })
      appendFileSync(target, `${new Date().toISOString()} ${message}\n`)
    } catch {
      // Diagnostics are best-effort.
    }
  }
}

/**
 * Record a failure where a human can find it. The loader reports plugin
 * failures only to its own console, which a desktop launch does not expose,
 * so a failed mount or a failed diary judgement would otherwise be invisible.
 */
function recordError(error: unknown): void {
  try {
    const dir = join(homedir(), '.dsh', 'mnemo')
    mkdirSync(dir, { recursive: true })
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    appendFileSync(join(dir, 'last-error.log'), `${new Date().toISOString()} ${detail}\n`)
  } catch {
    // Diagnostics must never mask the original failure.
  }
}

/**
 * Mount the memory runtime.
 *
 * Opening the database happens before registration so a broken path fails
 * loudly at load time instead of silently degrading every later write.
 * No `export default`: the loader's unwrapExports would drop `inject`.
 */
export function apply(ctx: Context, config: MnemoConfig): void {
  try {
    setup(ctx, config)
  } catch (error) {
    recordError(error)
    throw error
  }
}

function setup(ctx: Context, config: MnemoConfig): void {
  const db = openDatabase(config.dbPath)
  const recorder = new SessionRecorder(db)

  const engine = new DiaryEngine({
    db,
    idleMs: config.diaryIdleMinutes * 60_000,
    maxPerSession: config.diaryMaxPerSession,
    personaHint: config.diaryPersonaHint,
    onError: recordError,
    log: config.diaryDebug ? createDiaryLogger(config.dbPath) : undefined,
    generate: async (prompt) => {
      const stream = ctx.llm.stream({
        provider: config.diaryProvider,
        model: config.diaryModel,
        maxTokens: 220,
        temperature: 0.4,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      })
      let text = ''
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') {
          text += chunk.text
        } else if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') {
          break
        }
      }
      return text
    },
  })

  ctx.effect(() => () => {
    engine.dispose()
    db.close()
  })

  ctx.on('session/event', (session, event: SessionEvent) => {
    recorder.handle(session, event)
    if (event.type === 'turn/start') {
      engine.noteActivity(session.id)
    } else if (event.type === 'turn/end') {
      if (event.data.reason.kind === 'completed') engine.noteTurnEnd(session.id)
      refreshRelationStage(db, session.id)
    }
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
  ctx.tools.register(createDiaryWriteTool(db))
  ctx.tools.register(createDiaryUpdateTool(db))
  ctx.tools.register(createConsolidateTool(db, { flush: (sessionId) => engine.flush(sessionId) }))

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

  // Sessions that went quiet while the process was down still deserve a diary.
  void engine.catchUp()
}
