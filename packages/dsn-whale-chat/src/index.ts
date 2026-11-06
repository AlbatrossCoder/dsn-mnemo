import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ChatBridge } from './bridge/bridge.js'
import { asAddressed } from './bridge/message.js'
import { OneBotClient } from './channel/client.js'
import type { ChatMessage } from './channel/types.js'
import { createInterjectGate } from './interject/interject.js'
import { assemblePersona } from './persona/assemble.js'
import { BUILT_IN_PERSONAS, type Persona } from './persona/personas.js'
import { configFingerprint, createStateStore } from './persona/state.js'
import { ProactiveScheduler } from './proactive/proactive.js'
import { FollowBuffer } from './follow/follow.js'
import { Inbox } from './inbox/inbox.js'
import { BURST_GAP_MS, OutboundQueue, burstSegmentIndex } from './reply/outbound.js'
import { splitReply, typingDelay } from './reply/split.js'
import { createPersonaSetTool, createPersonaSwitchTool, createPersonaToggleTool } from './tools/persona.js'
import { createBalanceTool } from './tools/balance.js'
import { neighborSceneNote } from './util/neighbors.js'
import { matchesAny } from './util/text.js'

/** Cordis plugin name; must stay stable so profile entries can target it. */
export const name = 'dsn-whale-chat'

/** Services required before `apply` runs. */
export const inject = ['tools', 'sessions', 'systemPrompt', 'agents', 'llm']

/** Persona-independent living habits (stable prefix) — ethics, not SOP answers. */
const CHAT_POLICY = [
  '【相处】',
  '你是小鲸鱼。说完就完，别主动总结、别回头确认；对方问起再答。',
  '记不清就老实说记不清。别解释记忆、系统、插件。',
  '群里不当众翻别人的私事；主人私下跟你说的，不能外传。',
  '群里若有别的鱼在说话，别接成同一句式、同一套梗。',
  '只有主人能改人设和开关。',
].join('\n')

const CHANNEL_MECHANICS = '换行会分成多条消息发出。回复里不要带 [昵称/QQ号]。'

const GROUP_CHANNEL = `【当前场景】QQ 群聊。${CHANNEL_MECHANICS}没法 @ 到人。要提到谁，就喊你看见的昵称；起过外号的，就用外号。`
const PRIVATE_CHANNEL = `【当前场景】QQ 私聊。${CHANNEL_MECHANICS}`

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
    addressUser: z.string().default('主人'),
    custom: z.string().default(''),
    aliases: z.array(z.string()).default([...DEFAULT_ALIASES]),
    disliked: z.array(z.string()).default([...DEFAULT_DISLIKED]),
  }),

  /** The single user with maximum authority. Empty userId + claim=true claims on the first DM. */
  owner: z.object({
    userId: z.string().default(''),
    nickname: z.string().default(''),
    role: z.string().default('主人'),
    claim: z.boolean().default(true),
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
    maxPerMinute: z.natural().default(15),
    maxPerHour: z.natural().default(200),
    minGapMs: z.natural().default(1000),
  }),

  groupRate: z.object({
    debounceMs: z.natural().default(5000),
    batchSize: z.natural().default(0),
    cooldownMs: z.natural().default(0),
    maxPerMinute: z.natural().default(8),
    maxPerHour: z.natural().default(80),
    minGapMs: z.natural().default(2000),
  }),

  inbox: z.object({
    maxMessages: z.natural().default(10),
  }),

  replySplit: z.object({
    enabled: z.boolean().default(true),
    platformMaxChars: z.natural().default(4500),
  }),

  /** Private-chat typing status (NapCat supports it; other backends may not). */
  typingStatus: z.boolean().default(true),

  proactive: z.object({
    private: z.object({
      enabled: z.boolean().default(true),
      idleMinMinutes: z.natural().default(20),
      idleMaxMinutes: z.natural().default(200),
      maxPerDay: z.natural().default(1),
    }),
    group: z.object({
      enabled: z.boolean().default(false),
      idleMinMinutes: z.natural().default(20),
      idleMaxMinutes: z.natural().default(200),
      maxPerDay: z.natural().default(1),
    }),
  }),

  randomInterject: z.object({
    enabled: z.boolean().default(true),
    probability: z.number().default(0.05),
    minMessagesBetween: z.natural().default(20),
    windowMinutes: z.natural().default(10),
    maxPerWindow: z.natural().default(1),
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

const MAX_ERROR_LOG_BYTES = 256 * 1024

function recordError(error: unknown): void {
  try {
    const dir = join(homedir(), '.dsh', 'whale-chat')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'last-error.log')
    try {
      if (statSync(path).size > MAX_ERROR_LOG_BYTES) writeFileSync(path, '')
    } catch {
      // A missing log file is the normal first case.
    }
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    appendFileSync(path, `${new Date().toISOString()} ${detail}\n`)
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

  const defaults = {
    activeId: config.persona.active,
    name: findPersona(config.persona.active)?.name ?? config.persona.active,
    addressUser: config.persona.addressUser,
    custom: config.persona.custom,
    ownerId: config.owner.userId,
    addressPending: false,
    toggles: { ...config.toggles },
  }
  const state = createStateStore(
    expandHome(config.statePath),
    defaults,
    configFingerprint({
      ownerId: defaults.ownerId,
      addressUser: defaults.addressUser,
      activeId: defaults.activeId,
      toggles: defaults.toggles,
    }),
  )

  const client = new OneBotClient({
    url: config.wsUrl,
    token: config.accessToken,
    onMessage: (message) => receive(message),
    onError: (error) => recordError(error),
  })

  const outbound = new OutboundQueue({
    dm: {
      minGapMs: config.rate.minGapMs,
      maxPerMinute: config.rate.maxPerMinute,
      maxPerHour: config.rate.maxPerHour,
    },
    group: {
      minGapMs: config.groupRate.minGapMs,
      maxPerMinute: config.groupRate.maxPerMinute,
      maxPerHour: config.groupRate.maxPerHour,
    },
  })

  const bridge = new ChatBridge({
    ctx,
    reply: (target, text) => send(target, text),
    onError: (error) => recordError(error),
    onTurnEnd: (key) => finishTurn(key),
    onSpoken: (key, spoken) => {
      if (spoken) spokenKeys.add(key)
    },
    provider: config.provider.length === 0 ? undefined : config.provider,
    model: config.model.length === 0 ? undefined : config.model,
  })

  const rateFor = <T>(key: string, value: (rate: typeof config.rate) => T): T =>
    value(key.startsWith('group:') ? config.groupRate : config.rate)

  /** A group turn is in flight (reply, follow, interject, or idle). */
  const groupBusy = new Set<string>()
  /** This turn was a follow-up look, so silence closes the window. */
  const followTurns = new Set<string>()
  /** She produced a real reply during the turn that is still finishing. */
  const spokenKeys = new Set<string>()

  const inbox = new Inbox<ChatMessage>({
    debounceMs: (key) => rateFor(key, (rate) => rate.debounceMs),
    batchSize: (key) => rateFor(key, (rate) => rate.batchSize),
    cooldownMs: (key) => rateFor(key, (rate) => rate.cooldownMs),
    paused: (key) => groupBusy.has(key),
    max: config.inbox.maxMessages,
    onFlush: (key, messages, status) => flush(key, messages, status),
  })

  const follow = new FollowBuffer<ChatMessage>({
    debounceMs: () => config.groupRate.debounceMs,
    isBusy: (key) => groupBusy.has(key) || inbox.blocksIdle(key),
    onFlush: (key, messages) => flushFollow(key, messages),
  })

  const quiet: readonly [number, number] = [
    config.schedule.quietHours[0] ?? 23,
    config.schedule.quietHours[1] ?? 8,
  ]

  const privateProactive = new ProactiveScheduler({
    policy: {
      idleMinMs: config.proactive.private.idleMinMinutes * 60_000,
      idleMaxMs: config.proactive.private.idleMaxMinutes * 60_000,
      maxPerDay: config.proactive.private.maxPerDay,
      quietHours: quiet,
    },
    onFire: (key) => fireProactive(key),
  })
  const groupProactive = new ProactiveScheduler({
    policy: {
      idleMinMs: config.proactive.group.idleMinMinutes * 60_000,
      idleMaxMs: config.proactive.group.idleMaxMinutes * 60_000,
      maxPerDay: config.proactive.group.maxPerDay,
      quietHours: quiet,
    },
    onFire: (key) => fireProactive(key),
  })

  const interject = createInterjectGate({
    enabled: config.randomInterject.enabled,
    probability: config.randomInterject.probability,
    minMessagesBetween: config.randomInterject.minMessagesBetween,
    windowMinutes: config.randomInterject.windowMinutes,
    maxPerWindow: config.randomInterject.maxPerWindow,
  })

  function keyOf(message: ChatMessage): string {
    return message.kind === 'group' ? `group:${message.groupId}` : `user:${message.userId}`
  }

  function fireProactive(key: string): void {
    if (inbox.blocksIdle(key) || follow.blocksIdle(key) || groupBusy.has(key)) return
    const last = lastByKey.get(key)
    if (last === undefined) return
    singleShot.add(key)
    beginTurn(key)
    void bridge.proactive(last).catch((error) => recordError(error))
  }

  /** Timeout for a group turn, so a stuck agent cannot block the group forever. */
  const turnTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** A followup can land after the final step and never start a turn; release it. */
  const TURN_TIMEOUT_MS = 120_000

  function forceRelease(key: string): void {
    turnTimers.delete(key)
    if (!groupBusy.has(key)) return
    groupBusy.delete(key)
    followTurns.delete(key)
    spokenKeys.delete(key)
    inbox.settle(key)
    inbox.poke(key)
    follow.poke(key)
  }

  /** Mark a group turn so later chatter is watched instead of starting another turn. */
  function beginTurn(key: string): void {
    if (!key.startsWith('group:')) return
    groupBusy.add(key)
    follow.accept(key)
    const previous = turnTimers.get(key)
    if (previous !== undefined) clearTimeout(previous)
    turnTimers.set(key, setTimeout(() => forceRelease(key), TURN_TIMEOUT_MS))
  }

  /**
   * Was this group message meant for the bot?
   * Aliases alone do not wake her — only @, disliked names, `all`, or keywords.
   */
  function groupAddressed(message: ChatMessage): boolean {
    if (message.mentioned) return true
    const mode = config.trigger.group
    if (mode === 'all') return true
    if (matchesAny(message.text, config.persona.disliked)) return true
    if (mode === 'keyword' && matchesAny(message.text, config.trigger.keywords)) return true
    return false
  }

  /** Claim turns: the channel states that this is the first private chat. */
  const firstChats = new Set<string>()
  /**
   * A reply was cut off. The value is a generation so the turn that already
   * showed the fact can clear it without dropping a newer cut-off.
   */
  let interruptSerial = 0
  const pendingInterrupts = new Map<string, number>()
  const shownInterrupts = new Map<string, number>()
  /** Proactive and interject replies send a single QQ message. */
  const singleShot = new Set<string>()
  const lastByKey = new Map<string, ChatMessage>()
  /** Recent group lines for neighbor-fish echo detection. */
  const recentGroupLines = new Map<string, string[]>()

  function rememberGroupLine(key: string, text: string): void {
    if (!key.startsWith('group:')) return
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    const lines = recentGroupLines.get(key) ?? []
    lines.push(trimmed)
    if (lines.length > 12) lines.splice(0, lines.length - 12)
    recentGroupLines.set(key, lines)
  }

  /** Claim the owner on the first private message when none is configured yet. */
  function claimOwner(message: ChatMessage): boolean {
    if (message.kind !== 'dm' || !config.owner.claim) return false
    if (state.get().ownerId.length > 0) return false
    state.update({ ownerId: message.userId, addressPending: true })
    return true
  }

  /** `[昵称/QQ号] 正文` — lets the model attribute each line to a speaker. */
  function speakerTag(message: ChatMessage): string {
    const name = message.nickname !== null && message.nickname.trim().length > 0 ? message.nickname.trim() : message.userId
    return `[${name}/${message.userId}] ${message.text}`
  }

  function receive(raw: ChatMessage): void {
    const hasText = raw.text.trim().length > 0
    // A bare @ still counts as calling her; only empty chatter is ignored.
    if (!hasText && !raw.mentioned) return
    const message = hasText ? raw : { ...raw, text: '（@）' }
    const key = keyOf(message)
    const claimed = claimOwner(message)
    if (claimed) firstChats.add(key)
    if (message.kind === 'group' && state.get().ownerId.length === 0) return
    if (message.kind === 'group') rememberGroupLine(key, message.text)
    if (message.kind === 'group' && !groupAddressed(message)) {
      // After she has spoken, or while a group turn is already going, these
      // lines stay in the follow window instead of rolling interject.
      if (follow.isOpen(key) || groupBusy.has(key) || inbox.blocksIdle(key)) {
        follow.accept(key)
        follow.offer(key, message)
        lastByKey.set(key, message)
        return
      }
      if (interject()) {
        beginTurn(key)
        singleShot.add(key)
        void bridge.interject(message, speakerTag(message)).catch((error) => recordError(error))
      }
      return
    }
    const inbound = message.kind === 'group' ? asAddressed(message) : message
    lastByKey.set(key, inbound)
    // A direct call resets the follow-up slow-down.
    follow.reset(key)
    if (inbox.offer(key, inbound) !== 'queued') return
    // Only a message she will actually see stops the reply still going out.
    if (cancelPendingSend(key)) pendingInterrupts.set(key, ++interruptSerial)
    const proactive = message.kind === 'group' ? groupProactive : privateProactive
    const enabled = message.kind === 'group' ? config.proactive.group.enabled : config.proactive.private.enabled
    if (enabled) proactive.noteActivity(key)
  }

  function flush(key: string, messages: readonly ChatMessage[], _status: string): void {
    const last = messages[messages.length - 1]
    if (last === undefined) return
    beginTurn(key)
    void bridge
      .receive({ ...last, text: messages.map((message) => speakerTag(message)).join('\n') })
      .catch((error) => recordError(error))
  }

  function flushFollow(key: string, messages: readonly ChatMessage[]): void {
    const last = messages[messages.length - 1]
    if (last === undefined) return
    beginTurn(key)
    followTurns.add(key)
    void bridge
      .follow(last, messages.map((message) => speakerTag(message)).join('\n'))
      .catch((error) => recordError(error))
  }

  function finishTurn(key: string): void {
    const timer = turnTimers.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      turnTimers.delete(key)
    }
    groupBusy.delete(key)
    const spoke = spokenKeys.delete(key)
    const wasFollow = followTurns.delete(key)
    if (key.startsWith('group:')) {
      if (spoke) {
        follow.watch(key)
        // Every follow-up reply in a row makes the next batch wait longer.
        if (wasFollow) follow.bump(key)
      } else if (wasFollow) follow.close(key)
      else follow.release(key)
    }
    const pending = pendingInterrupts.get(key)
    const shown = shownInterrupts.get(key)
    if (pending !== undefined && pending === shown) {
      pendingInterrupts.delete(key)
      shownInterrupts.delete(key)
    }
    firstChats.delete(key)
    singleShot.delete(key)
    inbox.settle(key)
    if (groupBusy.has(key)) return
    inbox.poke(key)
    if (groupBusy.has(key)) return
    follow.poke(key)
  }

  interface SendToken {
    cancelled: boolean
    left: number
  }

  const sendTokens = new Map<string, SendToken>()

  /** Cancel segments that have not been sent yet. */
  function cancelPendingSend(key: string): boolean {
    const token = sendTokens.get(key)
    if (token === undefined || token.left <= 0 || token.cancelled) return false
    token.cancelled = true
    return true
  }

  function send(target: ChatMessage, text: string): void {
    const key = keyOf(target)
    cancelPendingSend(key)
    const kind = target.kind === 'group' ? 'group' : 'dm'
    const one = singleShot.delete(key)
    let segments = config.replySplit.enabled
      ? splitReply(text, { platformMaxChars: config.replySplit.platformMaxChars })
      : text.trim().length === 0
        ? []
        : [text.trim().slice(0, config.replySplit.platformMaxChars)]
    if (one) segments = segments.slice(0, 1)
    if (segments.length === 0) return
    const token: SendToken = { cancelled: false, left: segments.length }
    sendTokens.set(key, token)
    const closeAt = burstSegmentIndex(segments.length)
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as string
      const burst = index === closeAt
      outbound.enqueue({
        kind,
        burst,
        burstGapMs: BURST_GAP_MS,
        delayMs: burst ? BURST_GAP_MS + Math.floor(Math.random() * 300) : typingDelay(segment),
        cancelled: () => token.cancelled,
        beforeWait: () => {
          if (kind === 'dm' && config.typingStatus) client.setInputStatus(target.userId)
        },
        run: () => {
          token.left -= 1
          if (token.left <= 0) sendTokens.delete(key)
          try {
            if (target.kind === 'group' && target.groupId !== null) client.sendGroup(target.groupId, segment)
            else client.sendPrivate(target.userId, segment)
          } catch (error) {
            recordError(error)
          }
        },
      })
    }
  }

  ctx.effect(() => () => {
    client.stop()
    inbox.cancelAll()
    follow.cancelAll()
    for (const token of sendTokens.values()) token.cancelled = true
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

  ctx.systemPrompt.section({
    name: 'whale:policy',
    order: 21,
    interpolate: false,
    text: () => CHAT_POLICY,
  })

  function conversationKeyFromSession(id: string): string | undefined {
    const prefix = 'whale-chat:'
    if (!id.startsWith(prefix)) return undefined
    const rest = id.slice(prefix.length)
    const cut = rest.lastIndexOf(':')
    if (cut <= 0) return undefined
    return rest.slice(0, cut)
  }

  function channelText(key: string): string {
    const current = state.get()
    const scene = key.startsWith('group:') ? GROUP_CHANNEL : PRIVATE_CHANNEL
    const role = config.owner.role.trim().length > 0 ? config.owner.role.trim() : '主人'
    const owner =
      current.ownerId.length > 0
        ? current.addressPending || current.addressUser.trim().length === 0
          ? `【${role}】QQ ${current.ownerId}。称呼还没定。`
          : `【${role}】QQ ${current.ownerId}。称呼是「${current.addressUser}」。`
        : `【${role}】还没认主。`
    const lines = [scene, owner]
    if (firstChats.has(key)) lines.push('这是第一次私聊，称呼还没定。')
    const interrupt = pendingInterrupts.get(key)
    if (interrupt !== undefined) {
      if (!shownInterrupts.has(key)) shownInterrupts.set(key, interrupt)
      lines.push('上一条还没说完。')
    }
    // Queue urgency stays in code (rate/follow); do not inject ops status into her head.
    if (key.startsWith('group:')) {
      const note = neighborSceneNote(recentGroupLines.get(key) ?? [])
      if (note.length > 0) lines.push(note)
    }
    return lines.join('\n')
  }

  ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    const id = agent.session.id
    const key = conversationKeyFromSession(id)
    if (key === undefined) return
    agent.ctx.systemPrompt.context({
      name: 'whale:channel',
      order: 22,
      interpolate: false,
      text: () => channelText(key),
    })
  })

  ctx.tools.register(createPersonaSetTool(state))
  ctx.tools.register(createPersonaSwitchTool(state, personas))
  ctx.tools.register(createPersonaToggleTool(state))
  ctx.tools.register(createBalanceTool({ ctx }))

  try {
    client.start()
  } catch (error) {
    recordError(error)
  }
}
