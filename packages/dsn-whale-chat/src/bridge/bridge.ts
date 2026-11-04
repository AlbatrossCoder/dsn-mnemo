import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ChatMessage } from '../channel/types.js'
import { conversationKey, toUserMessage } from './message.js'
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
      try {
        this.options.reply(target, text)
      } catch (error) {
        this.options.onError?.(error)
      }
    })
  }

  async receive(message: ChatMessage): Promise<void> {
    const key = conversationKey(message)
    const agent = await this.agentFor(key)
    this.conversations.set(agent.session.id, message)
    agent.followup(toUserMessage(message))
  }

  private async agentFor(key: string): Promise<Agent> {
    const existing = this.agents.get(key)
    if (existing !== undefined) return existing
    const handle = await this.options.ctx.agents.create({
      sessionId: SessionId(`whale-chat:${key}:${randomUUID()}`),
      agentOptions: { provider: this.options.provider, model: this.options.model },
    })
    this.agents.set(key, handle.agent)
    return handle.agent
  }
}
