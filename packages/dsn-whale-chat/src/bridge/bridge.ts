import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ChatMessage } from '../channel/types.js'
import { conversationKey, toFollowMessage, toInterjectMessage, toProactiveMessage, toUserMessage } from './message.js'
import { assistantText } from './reply.js'

export interface BridgeOptions {
  readonly ctx: Context
  /** Deliver the assistant's reply back to QQ. */
  readonly reply: (target: ChatMessage, text: string) => void
  readonly onError?: (error: unknown) => void
  /** Fired when a turn finishes, so the inbound list can start the next one. */
  readonly onTurnEnd?: (key: string) => void
  /** Whether the assistant actually said something (`SILENT` is not spoken). */
  readonly onSpoken?: (key: string, spoken: boolean) => void
  readonly provider?: string
  readonly model?: string
}

/**
 * Route inbound QQ messages into one DSH agent per conversation, and send the
 * assistant's replies back out.
 *
 * Sessions are created with a per-process id, so a restart starts a fresh
 * session; cross-session memory is `dsn-mnemo`'s job, not this bridge's.
 * One conversation runs one turn at a time. The caller decides when the next
 * batch is ready.
 */
export class ChatBridge {
  private readonly agents = new Map<string, Agent>()
  private readonly conversations = new Map<SessionId, ChatMessage>()
  /** Last assistant text of the running turn; sent once, when the turn ends. */
  private readonly pendingReply = new Map<SessionId, string>()

  constructor(private readonly options: BridgeOptions) {
    options.ctx.on('session/event', (session, event) => {
      const target = this.conversations.get(session.id)
      if (target === undefined) return
      if (event.type === 'assistant/message') {
        // A turn may produce text before a tool call and again after it. Keep
        // the last one and send it once, so the pre-tool draft is not also sent.
        const text = assistantText(event.data.message.content)
        if (text.length === 0) return
        this.pendingReply.set(session.id, text)
        return
      }
      if (event.type !== 'turn/end') return
      const text = this.pendingReply.get(session.id) ?? ''
      this.pendingReply.delete(session.id)
      // The idle nudge can be declined; "SILENT" is never sent to QQ.
      const spoken = text.trim().length > 0 && text.trim().toUpperCase() !== 'SILENT'
      this.options.onSpoken?.(conversationKey(target), spoken)
      if (spoken) {
        try {
          this.options.reply(target, text)
        } catch (error) {
          this.options.onError?.(error)
        }
      }
      this.options.onTurnEnd?.(conversationKey(target))
    })
  }

  async receive(message: ChatMessage): Promise<void> {
    const key = conversationKey(message)
    const agent = await this.agentFor(key)
    this.conversations.set(agent.session.id, message)
    agent.followup(toUserMessage(message))
  }

  /** Wake the agent for an idle proactive turn; it may answer or stay silent. */
  async proactive(target: ChatMessage): Promise<void> {
    const key = conversationKey(target)
    const agent = await this.agentFor(key)
    this.conversations.set(agent.session.id, target)
    agent.followup(toProactiveMessage(target))
  }

  /** Wake the agent to consider continuing a group topic it already joined. */
  async follow(target: ChatMessage, text: string): Promise<void> {
    const key = conversationKey(target)
    const agent = await this.agentFor(key)
    this.conversations.set(agent.session.id, target)
    agent.followup(toFollowMessage(target, text))
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
