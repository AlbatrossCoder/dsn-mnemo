/**
 * Session event recorder for L0.
 *
 * The recorder subscribes to `session/event` and folds **conversation** into
 * the message table: human prompts and the assistant's visible replies. It
 * never throws: losing a memory row must not break the conversation.
 *
 * Not recorded, by design: reasoning, tool calls, and tool results. L0 is a
 * chat log; the diary layer is what turns it into long-term memory.
 *
 * @module dsn-mnemo/session/recorder
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { DatabaseSync } from 'node:sqlite'
import { flattenContent } from './flatten.js'
import { insertMessage, touchSession, type MessageRole } from '../store/message-store.js'

/** The only session surface the recorder needs. */
export interface RecorderSession {
  readonly id: string
}

interface MessageShape {
  readonly role?: unknown
  readonly id?: unknown
  readonly content?: unknown
  readonly source?: { readonly kind?: unknown }
}

function asMessage(value: unknown): MessageShape | undefined {
  return typeof value === 'object' && value !== null ? (value as MessageShape) : undefined
}

function roleOf(message: MessageShape): MessageRole | undefined {
  switch (message.role) {
    case 'user':
    case 'assistant':
      return message.role
    // Tool results are not conversation; they are skipped before flattening.
    default:
      return undefined
  }
}

/**
 * User-role messages also carry injected context (time, goal rounds, runtime
 * snapshots, skill catalogs). Only `source.kind === 'user'` is a human prompt.
 */
function isHumanPrompt(message: MessageShape): boolean {
  return message.source?.kind === 'user'
}

/** Options for what L0 keeps beyond the searchable text. */
export interface RecorderOptions {
  /**
   * Keep the model's reasoning blocks in the stored raw JSON. Off by default:
   * thinking is not memory, and keeping it costs space and privacy.
   */
  readonly storeReasoning?: boolean
}

/** Drop reasoning blocks from a message's content before persisting raw JSON. */
function withoutReasoning(message: MessageShape): MessageShape {
  if (!Array.isArray(message.content)) return message
  const content = message.content.filter(
    (block) => !(typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'reasoning'),
  )
  return { ...message, content }
}

export class SessionRecorder {
  /** Last opened turn per session; `user/message` payloads carry no turn field. */
  private readonly turns = new Map<string, number>()
  private readonly storeReasoning: boolean

  constructor(
    private readonly db: DatabaseSync,
    options: RecorderOptions = {},
  ) {
    this.storeReasoning = options.storeReasoning ?? false
  }

  /** Fold one session event into L0. Errors are swallowed by design. */
  handle(session: RecorderSession, event: SessionEvent): void {
    try {
      switch (event.type) {
        case 'turn/start':
          this.turns.set(session.id, event.data.turn)
          touchSession(this.db, session.id, event.data.turn)
          return
        case 'turn/end':
          touchSession(this.db, session.id, event.data.turn)
          this.turns.delete(session.id)
          return
        case 'user/message':
        case 'assistant/message': {
          const payload = event.data as { message?: unknown; turn?: number }
          const message = asMessage(event.type === 'user/message' ? event.data : payload.message)
          if (message === undefined) return
          const role = roleOf(message)
          if (role === undefined) return
          if (role === 'user' && !isHumanPrompt(message)) return
          const turn = payload.turn ?? this.turns.get(session.id) ?? 0
          touchSession(this.db, session.id, turn)
          const content = flattenContent(Array.isArray(message.content) ? message.content : [])
          // A pure tool-call step has no visible text; nothing was said.
          if (content.length === 0) return
          const stored = this.storeReasoning ? message : withoutReasoning(message)
          insertMessage(this.db, {
            sessionId: session.id,
            seq: event.seq,
            turn,
            role,
            messageId: typeof message.id === 'string' ? message.id : null,
            content,
            raw: JSON.stringify(stored),
          })
          return
        }
        default:
          return
      }
    } catch {
      // Memory capture is best-effort; a broken row must never surface to the agent loop.
    }
  }
}
