import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ChatBridge } from './bridge/bridge.js'
import { OneBotClient } from './channel/client.js'
import type { ChatMessage } from './channel/types.js'
import { assemblePersona } from './persona/assemble.js'
import { BUILT_IN_PERSONAS, findPersona } from './persona/personas.js'
import { createStateStore } from './persona/state.js'
import { ProactiveScheduler } from './proactive/proactive.js'
import { RateController } from './rate/rate.js'
import { createPersonaSetTool, createPersonaSwitchTool, createPersonaToggleTool } from './tools/persona.js'

/** Cordis plugin name; must stay stable so profile entries can target it. */
export const name = 'dsn-whale-chat'

/** Services required before `apply` runs. */
export const inject = ['tools', 'sessions', 'systemPrompt', 'agents']

/** User-facing configuration (see docs/chat-plugin.md). */
export const Config = z.object({
  wsUrl: z.string().default('ws://127.0.0.1:3001'),
  accessToken: z.string().default(''),
  statePath: z.string().default('~/.dsh/whale-chat-state.json'),
  activePersona: z.string().default('little-whale'),
  addressUser: z.string().default('哥哥'),
  mischief: z.boolean().default(false),
  queen: z.boolean().default(false),
  kaomoji: z.boolean().default(false),
  groupTrigger: z.string().default('at'),
  provider: z.string().default(''),
  model: z.string().default(''),
  debounceMs: z.natural().default(800),
  groupDebounceMs: z.natural().default(1500),
  groupBatchSize: z.natural().default(5),
  groupCooldownMs: z.natural().default(30_000),
  groupMaxPerMinute: z.natural().default(3),
  groupMaxPerHour: z.natural().default(30),
  proactivePrivate: z.boolean().default(false),
  proactiveGroup: z.boolean().default(false),
  proactiveIdleMinutes: z.natural().default(30),
  proactiveMaxPerDay: z.natural().default(1),
  quietStart: z.natural().default(23),
  quietEnd: z.natural().default(8),
})

export type WhaleChatConfig = Schemastery.TypeT<typeof Config>

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function recordError(error: unknown): void {
  try {
    const dir = join(homedir(), '.dsh', 'whale-chat')
    mkdirSync(dir, { recursive: true })
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    appendFileSync(join(dir, 'last-error.log'), `${new Date().toISOString()} ${detail}\n`)
  } catch {
    // Diagnostics must never mask the original failure.
  }
}

export function apply(ctx: Context, config: WhaleChatConfig): void {
  const state = createStateStore(expandHome(config.statePath), {
    activeId: config.activePersona,
    name: findPersona(config.activePersona)?.name ?? config.activePersona,
    addressUser: config.addressUser,
    custom: '',
    toggles: { mischief: config.mischief, queen: config.queen, kaomoji: config.kaomoji },
  })

  const client = new OneBotClient({
    url: config.wsUrl,
    token: config.accessToken,
    onMessage: (message) => receive(message),
    onError: (error) => recordError(error),
  })

  const bridge = new ChatBridge({
    ctx,
    reply: (target, text) => send(target, text),
    onError: (error) => recordError(error),
    provider: config.provider.length === 0 ? undefined : config.provider,
    model: config.model.length === 0 ? undefined : config.model,
  })

  const lastByKey = new Map<string, ChatMessage>()
  const privateRate = new RateController({
    policy: { debounceMs: config.debounceMs, batchSize: 0, cooldownMs: 0, maxPerMinute: 20, maxPerHour: 1000 },
    onFlush: (key, texts) => flush(key, texts),
  })
  const groupRate = new RateController({
    policy: {
      debounceMs: config.groupDebounceMs,
      batchSize: config.groupBatchSize,
      cooldownMs: config.groupCooldownMs,
      maxPerMinute: config.groupMaxPerMinute,
      maxPerHour: config.groupMaxPerHour,
    },
    onFlush: (key, texts) => flush(key, texts),
  })

  const proactive = new ProactiveScheduler({
    policy: {
      idleMs: config.proactiveIdleMinutes * 60_000,
      maxPerDay: config.proactiveMaxPerDay,
      quietHours: [config.quietStart, config.quietEnd],
    },
    onFire: (key) => {
      const last = lastByKey.get(key)
      if (last !== undefined) void bridge.proactive(last)
    },
  })

  function keyOf(message: ChatMessage): string {
    return message.kind === 'group' ? `group:${message.groupId}` : `user:${message.userId}`
  }

  function receive(message: ChatMessage): void {
    if (message.text.trim().length === 0) return
    if (message.kind === 'group' && config.groupTrigger === 'at' && !message.mentioned) return
    const key = keyOf(message)
    lastByKey.set(key, message)
    const rate = message.kind === 'group' ? groupRate : privateRate
    rate.offer(key, message.text)
    const proactiveEnabled = message.kind === 'group' ? config.proactiveGroup : config.proactivePrivate
    if (proactiveEnabled) proactive.noteActivity(key)
  }

  function flush(key: string, texts: readonly string[]): void {
    const last = lastByKey.get(key)
    if (last === undefined) return
    void bridge.receive({ ...last, text: texts.join('\n') })
  }

  function send(target: ChatMessage, text: string): void {
    if (target.kind === 'group' && target.groupId !== null) client.sendGroup(target.groupId, text)
    else client.sendPrivate(target.userId, text)
  }

  ctx.effect(() => () => {
    client.stop()
    privateRate.cancelAll()
    groupRate.cancelAll()
    proactive.cancelAll()
  })

  // Stable prefix: the assembled persona. It changes only when the config, a
  // toggle, or the user's personalization changes — keeping the cache warm.
  ctx.systemPrompt.section({
    name: 'whale:persona',
    order: 20,
    interpolate: false,
    text: () => {
      const current = state.get()
      const persona = findPersona(current.activeId) ?? BUILT_IN_PERSONAS[0]
      if (persona === undefined) return ''
      return assemblePersona(persona, {
        addressUser: current.addressUser,
        custom: current.custom,
        toggles: current.toggles,
      })
    },
  })

  ctx.tools.register(createPersonaSetTool(state))
  ctx.tools.register(createPersonaSwitchTool(state, BUILT_IN_PERSONAS))
  ctx.tools.register(createPersonaToggleTool(state))

  try {
    client.start()
  } catch (error) {
    recordError(error)
  }
}
