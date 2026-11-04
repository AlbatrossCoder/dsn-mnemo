import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ChatMessage } from '../channel/types.js'
import {
  conversationKey,
  toClaimMessage,
  toInterjectMessage,
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

  constructor(private readonly options: BridgeOptions) {
    options.ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const target = this.conversations.get(session.id)
      if (target === undefined) return
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

  async receive(message: ChatMessage, options: { claim?: boolean; remind?: boolean } = {}): Promise<void> {
    const key = conversationKey(message)
    const agent = await this.agentFor(key)
    this.conversations.set(agent.session.id, message)
    if (options.claim === true) agent.inject(toClaimMessage(message))
    else if (options.remind === true) agent.inject(toRemindAddressMessage(message))
    agent.followup(toUserMessage(message))
  }

  /** Wake the agent for an idle proactive turn; it may answer or stay silent. */
  async proactive(target: ChatMessage): Promise<void> {
    const key = conversationKey(target)
    const agent = await this.agentFor(key)
    this.conversations.set(agent.session.id, target)
    agent.followup(toProactiveMessage(target))
  }

  /** Wake the agent to consider joining a group message it was not addressed in. */
  async interject(target: ChatMessage, text: string): Promise<void> {
    const key = conversationKey(target)
    const agent = await this.agentFor(key)
    this.conversations.set(agent.session.id, target)
    agent.followup(toInterjectMessage(target, text))
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
