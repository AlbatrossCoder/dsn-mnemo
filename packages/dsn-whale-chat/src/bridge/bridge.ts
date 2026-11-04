import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ChatMessage } from '../channel/types.js'
import {
  conversationKey,
  toClaimMessage,
  toInterjectMessage,
  toInterruptedMessage,
  toOverwhelmedMessage,
  toProactiveMessage,
  toRemindAddressMessage,
  toUserMessage,
} from './message.js'
import { assistantText } from './reply.js'

export interface BridgeOptions {
  readonly ctx: Context
  /** Deliver the assistant's reply back to QQ. */
  readonly reply: (target: ChatMessage, text: string) => void
  readonly onError?: (error: unknown) => void
  readonly provider?: string
  readonly model?: string
  /** Max queued/running turns per conversation before new messages are held. */
  readonly maxPendingTurns?: number
  /** Max messages held while saturated; beyond this the newest are dropped. */
  readonly maxBufferedMessages?: number
}

/**
 * Route inbound QQ messages into one DSH agent per conversation, and send the
 * assistant's replies back out.
 *
 * Sessions are created with a per-process id, so a restart starts a fresh
 * session; cross-session memory is `dsn-mnemo`'s job, not this bridge's.
 */
export class ChatBridge {
  private readonly agents = new Map<string, Agent>()
  private readonly conversations = new Map<SessionId, ChatMessage>()
  private readonly maxPending: number
  private readonly maxBuffered: number
  /** Queued + running turns per conversation. */
  private readonly pending = new Map<string, number>()
  /** Messages held while the conversation is saturated; drained as one turn. */
  private readonly buffered = new Map<string, ChatMessage[]>()
  /** Flooded conversations that should be told about it on the next turn. */
  private readonly overwhelmed = new Set<string>()

  constructor(private readonly options: BridgeOptions) {
    this.maxPending = options.maxPendingTurns ?? 5
    this.maxBuffered = options.maxBufferedMessages ?? 10
    options.ctx.on('session/event', (session, event) => {
      const target = this.conversations.get(session.id)
      if (target === undefined) return
      if (event.type === 'turn/end') {
        const key = conversationKey(target)
        this.pending.set(key, Math.max(0, (this.pending.get(key) ?? 1) - 1))
        void this.drain(key)
        return
      }
      if (event.type !== 'assistant/message') return
      const text = assistantText(event.data.message.content)
      if (text.length === 0) return
      // The idle nudge can be declined; "SILENT" is never sent to QQ.
      if (text.trim().toUpperCase() === 'SILENT') return
      try {
        this.options.reply(target, text)
      } catch (error) {
        this.options.onError?.(error)
      }
    })
  }

  async receive(
    message: ChatMessage,
    options: { claim?: boolean; remind?: boolean; interrupted?: boolean } = {},
  ): Promise<void> {
    const key = conversationKey(message)
    if (!this.admit(key)) {
      this.overflow(key, message)
      return
    }
    const agent = await this.agentFor(key)
    this.conversations.set(agent.session.id, message)
    if (options.claim === true) agent.inject(toClaimMessage(message))
    else if (options.remind === true) agent.inject(toRemindAddressMessage(message))
    if (options.interrupted === true) agent.inject(toInterruptedMessage(message))
    if (this.overwhelmed.delete(key)) agent.inject(toOverwhelmedMessage(message))
    agent.followup(toUserMessage(message))
  }

  /** Wake the agent for an idle proactive turn; it may answer or stay silent. */
  async proactive(target: ChatMessage): Promise<void> {
    const key = conversationKey(target)
    if (!this.admit(key)) return
    const agent = await this.agentFor(key)
    this.conversations.set(agent.session.id, target)
    agent.followup(toProactiveMessage(target))
  }

  /** Wake the agent to consider joining a group message it was not addressed in. */
  async interject(target: ChatMessage, text: string): Promise<void> {
    const key = conversationKey(target)
    if (!this.admit(key)) return
    const agent = await this.agentFor(key)
    this.conversations.set(agent.session.id, target)
    agent.followup(toInterjectMessage(target, text))
  }

  /** Reserve a slot for one turn; false when the conversation is saturated. */
  private admit(key: string): boolean {
    const pending = this.pending.get(key) ?? 0
    if (pending >= this.maxPending) return false
    this.pending.set(key, pending + 1)
    return true
  }

  /** Hold the message while saturated; beyond the buffer limit the newest is dropped. */
  private overflow(key: string, message: ChatMessage): void {
    const buffered = this.buffered.get(key) ?? []
    if (buffered.length >= this.maxBuffered) {
      this.overwhelmed.add(key)
      return
    }
    buffered.push(message)
    this.buffered.set(key, buffered)
  }

  /** After a turn ends, merge whatever was held into one chained turn. */
  private async drain(key: string): Promise<void> {
    const buffered = this.buffered.get(key)
    if (buffered === undefined || buffered.length === 0) return
    if (!this.admit(key)) return
    this.buffered.delete(key)
    const last = buffered[buffered.length - 1] as ChatMessage
    const text = buffered.map((message) => message.text).join('\n')
    const agent = await this.agentFor(key)
    this.conversations.set(agent.session.id, last)
    if (this.overwhelmed.delete(key)) agent.inject(toOverwhelmedMessage(last))
    agent.followup(toUserMessage({ ...last, text }))
  }

  private async agentFor(key: string): Promise<Agent> {
    const existing = this.agents.get(key)
    if (existing !== undefined) return existing
    // Omit empty fields so the loop resolves its own default route.
    const agentOptions: { provider?: string; model?: string } = {}
    if (this.options.provider !== undefined) agentOptions.provider = this.options.provider
    if (this.options.model !== undefined) agentOptions.model = this.options.model
    const handle = await this.options.ctx.agents.create({
      sessionId: SessionId(`whale-chat:${key}:${randomUUID()}`),
      agentOptions,
    })
    this.agents.set(key, handle.agent)
    return handle.agent
  }
}
