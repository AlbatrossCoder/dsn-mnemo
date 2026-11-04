import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ChatBridge } from './bridge/bridge.js'
import { OneBotClient } from './channel/client.js'
import type { ChatMessage } from './channel/types.js'
import { createInterjectGate } from './interject/interject.js'
import { assemblePersona } from './persona/assemble.js'
import { BUILT_IN_PERSONAS, type Persona } from './persona/personas.js'
import { createStateStore } from './persona/state.js'
import { ProactiveScheduler } from './proactive/proactive.js'
import { RateController } from './rate/rate.js'
import { createPersonaSetTool, createPersonaSwitchTool, createPersonaToggleTool } from './tools/persona.js'
import { matchesAny } from './util/text.js'

/** Cordis plugin name; must stay stable so profile entries can target it. */
export const name = 'dsn-whale-chat'

/** Services required before `apply` runs. */
export const inject = ['tools', 'sessions', 'systemPrompt', 'agents', 'llm']

const DEFAULT_ALIASES = ['小鲸鱼', '鲸鱼', '鲸鲸', '鱼鱼', '鲸鱼娘']
const DEFAULT_DISLIKED = ['大肥鱼', '小肥鱼', '喂']

/** User-facing configuration (mirrors docs/chat-plugin.md §6). */
export const Config = z.object({
  wsUrl: z.string().default('ws://127.0.0.1:3001'),
  accessToken: z.string().default(''),
  statePath: z.string().default('~/.dsh/whale-chat-state.json'),
  provider: z.string().default(''),
  model: z.string().default(''),

  persona: z.object({
    active: z.string().default('little-whale'),
    addressUser: z.string().default('哥哥'),
    custom: z.string().default(''),
    aliases: z.array(z.string()).default([...DEFAULT_ALIASES]),
    disliked: z.array(z.string()).default([...DEFAULT_DISLIKED]),
  }),

  /** Extra personas appended on top of the built-ins (same id overrides). */
  personas: z.array(z.any()).default([]),

  toggles: z.object({
    mischief: z.boolean().default(false),
    queen: z.boolean().default(false),
    kaomoji: z.boolean().default(false),
    troll: z.boolean().default(false),
  }),

  trigger: z.object({
    /** `at` | `all` | `keyword`. */
    group: z.string().default('at'),
    keywords: z.array(z.string()).default([]),
  }),

  rate: z.object({
    debounceMs: z.natural().default(3000),
    batchSize: z.natural().default(0),
    cooldownMs: z.natural().default(0),
    maxPerMinute: z.natural().default(20),
  }),

  groupRate: z.object({
    debounceMs: z.natural().default(5000),
    batchSize: z.natural().default(5),
    cooldownMs: z.natural().default(30_000),
    maxPerMinute: z.natural().default(3),
    maxPerHour: z.natural().default(30),
  }),

  proactive: z.object({
    private: z.object({
      enabled: z.boolean().default(false),
      idleMinutes: z.natural().default(30),
      maxPerDay: z.natural().default(1),
    }),
    group: z.object({
      enabled: z.boolean().default(false),
      idleMinutes: z.natural().default(60),
      maxPerDay: z.natural().default(1),
    }),
  }),

  randomInterject: z.object({
    enabled: z.boolean().default(false),
    probability: z.number().default(0.05),
    minMessagesBetween: z.natural().default(20),
    maxPerHour: z.natural().default(2),
  }),

  schedule: z.object({
    quietHours: z.array(z.natural()).default([23, 8]),
  }),
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

/** Built-ins plus config-supplied personas; a custom id overrides a built-in. */
function mergePersonas(builtIn: readonly Persona[], custom: readonly Persona[]): Persona[] {
  const byId = new Map<string, Persona>()
  for (const persona of builtIn) byId.set(persona.id, persona)
  for (const persona of custom) byId.set(persona.id, persona)
  return [...byId.values()]
}

export function apply(ctx: Context, config: WhaleChatConfig): void {
  const personas = mergePersonas(BUILT_IN_PERSONAS, config.personas as readonly Persona[])
  const findPersona = (id: string): Persona | undefined => personas.find((persona) => persona.id === id)

  const state = createStateStore(expandHome(config.statePath), {
    activeId: config.persona.active,
    name: findPersona(config.persona.active)?.name ?? config.persona.active,
    addressUser: config.persona.addressUser,
    custom: config.persona.custom,
    toggles: { ...config.toggles },
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
    policy: {
      debounceMs: config.rate.debounceMs,
      batchSize: config.rate.batchSize,
      cooldownMs: config.rate.cooldownMs,
      maxPerMinute: config.rate.maxPerMinute,
      maxPerHour: Number.MAX_SAFE_INTEGER,
    },
    onFlush: (key, texts) => flush(key, texts),
  })
  const groupRate = new RateController({
    policy: {
      debounceMs: config.groupRate.debounceMs,
      batchSize: config.groupRate.batchSize,
      cooldownMs: config.groupRate.cooldownMs,
      maxPerMinute: config.groupRate.maxPerMinute,
      maxPerHour: config.groupRate.maxPerHour,
    },
    onFlush: (key, texts) => flush(key, texts),
  })

  const quiet: readonly [number, number] = [
    config.schedule.quietHours[0] ?? 23,
    config.schedule.quietHours[1] ?? 8,
  ]

  const privateProactive = new ProactiveScheduler({
    policy: {
      idleMs: config.proactive.private.idleMinutes * 60_000,
      maxPerDay: config.proactive.private.maxPerDay,
      quietHours: quiet,
    },
    onFire: (key) => fireProactive(key),
  })
  const groupProactive = new ProactiveScheduler({
    policy: {
      idleMs: config.proactive.group.idleMinutes * 60_000,
      maxPerDay: config.proactive.group.maxPerDay,
      quietHours: quiet,
    },
    onFire: (key) => fireProactive(key),
  })

  const interject = createInterjectGate({
    enabled: config.randomInterject.enabled,
    probability: config.randomInterject.probability,
    minMessagesBetween: config.randomInterject.minMessagesBetween,
    maxPerHour: config.randomInterject.maxPerHour,
  })

  function keyOf(message: ChatMessage): string {
    return message.kind === 'group' ? `group:${message.groupId}` : `user:${message.userId}`
  }

  function fireProactive(key: string): void {
    const last = lastByKey.get(key)
    if (last !== undefined) void bridge.proactive(last).catch((error) => recordError(error))
  }

  /** Was this group message meant for the bot (by @, name, or keyword)? */
  function groupAddressed(message: ChatMessage): boolean {
    if (message.mentioned) return true
    const mode = config.trigger.group
    if (mode === 'all') return true
    if (matchesAny(message.text, config.persona.aliases)) return true
    if (matchesAny(message.text, config.persona.disliked)) return true
    if (mode === 'keyword' && matchesAny(message.text, config.trigger.keywords)) return true
    return false
  }

  function receive(message: ChatMessage): void {
    if (message.text.trim().length === 0) return
    if (message.kind === 'group' && !groupAddressed(message)) {
      // Group chatter the bot was not addressed in: maybe join in (off by default).
      if (interject()) void bridge.interject(message, message.text).catch((error) => recordError(error))
      return
    }
    const key = keyOf(message)
    lastByKey.set(key, message)
    const rate = message.kind === 'group' ? groupRate : privateRate
    rate.offer(key, message.text)
    const proactive = message.kind === 'group' ? groupProactive : privateProactive
    const enabled = message.kind === 'group' ? config.proactive.group.enabled : config.proactive.private.enabled
    if (enabled) proactive.noteActivity(key)
  }

  function flush(key: string, texts: readonly string[]): void {
    const last = lastByKey.get(key)
    if (last === undefined) return
    void bridge.receive({ ...last, text: texts.join('\n') }).catch((error) => recordError(error))
  }

  function send(target: ChatMessage, text: string): void {
    if (target.kind === 'group' && target.groupId !== null) client.sendGroup(target.groupId, text)
    else client.sendPrivate(target.userId, text)
  }

  ctx.effect(() => () => {
    client.stop()
    privateRate.cancelAll()
    groupRate.cancelAll()
    privateProactive.cancelAll()
    groupProactive.cancelAll()
  })

  // Stable prefix: the assembled persona. It changes only when the config, a
  // toggle, or the user's personalization changes — keeping the cache warm.
  ctx.systemPrompt.section({
    name: 'whale:persona',
    order: 20,
    interpolate: false,
    text: () => {
      const current = state.get()
      const persona = findPersona(current.activeId) ?? personas[0]
      if (persona === undefined) return ''
      return assemblePersona(persona, {
        addressUser: current.addressUser,
        custom: current.custom,
        toggles: current.toggles,
      })
    },
  })

  ctx.tools.register(createPersonaSetTool(state))
  ctx.tools.register(createPersonaSwitchTool(state, personas))
  ctx.tools.register(createPersonaToggleTool(state))

  try {
    client.start()
  } catch (error) {
    recordError(error)
  }
}
