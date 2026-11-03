import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from './db/database.js'
import { createPendingDiaryText } from './diary/pending.js'
import { createProactiveText } from './inject/proactive.js'
import { formatDate, renderAnchorLines, renderStablePrefix } from './inject/stable-prefix.js'
import { SessionRecorder } from './session/recorder.js'
import { anchorsInWindow, markAnchorFired } from './store/anchor-store.js'
import { sessionSubject } from './store/message-store.js'
import { purgeExpiredPoints } from './store/point-store.js'
import { createAnchorTool } from './tools/anchor-upsert.js'
import { createDiaryUpdateTool, createDiaryWriteTool } from './tools/diary-write.js'
import { createForgetTool } from './tools/forget.js'
import { createRecallTool } from './tools/recall.js'

/** Cordis plugin name; must stay stable so profile entries can target it. */
export const name = 'mnemo'

/**
 * Services required before `apply` runs. `systemPrompt` owns the cached stable
 * prefix, `sessions` supplies the L0 event stream, `tools` is the registry.
 *
 * The memory runtime never calls a model: it only records, stores, retrieves,
 * and injects hints. Deciding what to write is the running model's job — it
 * calls `diary_write` / `anchor_upsert` itself.
 */
export const inject = ['tools', 'sessions', 'systemPrompt']

/** User-facing configuration. */
export const Config = z.object({
  dbPath: z.string().default('~/.dsh/mnemo/mnemo.db'),
  diaryIdleMinutes: z.natural().min(5).max(1440).default(20),
  diaryMaxTurns: z.natural().min(10).max(500).default(30),
  diaryMaxChars: z.natural().min(2000).max(200000).default(12000),
  storeReasoning: z.boolean().default(false),
  anchorWindowDays: z.natural().default(2),
  contextRecallLimit: z.natural().default(20),
  contextRecallTokens: z.natural().default(600),
  recallDiaryLimit: z.natural().default(5),
  recallLogLimit: z.natural().default(5),
})

export type MnemoConfig = Schemastery.TypeT<typeof Config>

const VERSION = '0.7.1'

/**
 * Record a failure where a human can find it. The loader reports plugin
 * failures only to its own console, which a desktop launch does not expose,
 * so a failed mount would otherwise be invisible.
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
  purgeExpiredPoints(db)
  const recorder = new SessionRecorder(db, { storeReasoning: config.storeReasoning })

  ctx.effect(() => () => db.close())

  ctx.on('session/event', (session, event: SessionEvent) => {
    recorder.handle(session, event)
  })

  // Stable prefix: memory rules only. Anchors are injected per agent below, so
  // this block stays byte-stable for a given day and the cached prefix holds.
  ctx.systemPrompt.section({
    name: 'mnemo:rules',
    order: 30,
    interpolate: false,
    text: () => renderStablePrefix([], formatDate(new Date())),
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
  ctx.tools.register(createForgetTool(db))

  // Dynamic context: proactive recall + a pending-diary hint, both replaced
  // every turn (never accumulated) and living outside the cached stable prefix.
  const proactive = createProactiveText(db, {
    limit: config.contextRecallLimit,
    tokenBudget: config.contextRecallTokens,
  })
  const pending = createPendingDiaryText(db, {
    idleMs: config.diaryIdleMinutes * 60_000,
    maxTurns: config.diaryMaxTurns,
    maxChars: config.diaryMaxChars,
  })

  ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    agent.ctx.systemPrompt.context({
      name: 'mnemo:recall',
      order: 40,
      interpolate: false,
      text: () => proactive(agent.session),
    })
    // Per-agent anchors: each subject (person or group) sees only its own.
    agent.ctx.systemPrompt.context({
      name: 'mnemo:anchors',
      order: 35,
      interpolate: false,
      text: () => {
        const subject = sessionSubject(db, agent.session.id)
        const today = formatDate(new Date())
        const due = anchorsInWindow(db, subject, today, config.anchorWindowDays).filter(
          (anchor) => anchor.lastFiredOn !== today && anchor.handledAt === null,
        )
        if (due.length === 0) return ''
        for (const anchor of due) markAnchorFired(db, anchor.id, today)
        return renderAnchorLines(due, today)
      },
    })
    agent.ctx.systemPrompt.context({
      name: 'mnemo:pending',
      order: 45,
      interpolate: false,
      text: () => pending(agent.session),
    })
  })
}
