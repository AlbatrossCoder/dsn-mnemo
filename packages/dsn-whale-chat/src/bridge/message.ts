import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { ChatMessage } from '../channel/types.js'

/**
 * Declare the QQ identity a channel message carries. `MessageSourceMap` is
 * merge-extensible (see `@deepseek-ai/dsh-llm/message`), so this adds the `qq`
 * producer without touching the harness.
 */
declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap {
    qq: {
      readonly kind: 'qq'
      readonly userId: string
      readonly groupId?: string
      readonly nickname?: string
      readonly mentioned?: boolean
    }
    /** A synthetic "you may speak" nudge; never a chat-log message. */
    'qq-proactive': {
      readonly kind: 'qq-proactive'
      readonly userId: string
      readonly groupId?: string
    }
  }
}

/** One conversation = one agent/session; the key names that conversation. */
export function conversationKey(message: ChatMessage): string {
  return message.kind === 'group' ? `group:${message.groupId}` : `user:${message.userId}`
}

/**
 * Group messages that passed the address check must be stored as addressed,
 * even when the trigger was a name or a keyword rather than an @.
 */
export function asAddressed(message: ChatMessage): ChatMessage {
  if (message.kind !== 'group' || message.mentioned) return message
  return { ...message, mentioned: true }
}

/** Build the identified user message the agent will receive. */
export function toUserMessage(message: ChatMessage) {
  return createUserMessage({
    content: [{ type: 'text', text: message.text }],
    source: {
      kind: 'qq',
      userId: message.userId,
      ...(message.groupId === null ? {} : { groupId: message.groupId }),
      ...(message.nickname === null ? {} : { nickname: message.nickname }),
      mentioned: message.mentioned,
    },
  })
}

/**
 * Build a synthetic "you may speak" nudge. The model answers with a message,
 * or `SILENT` to stay quiet; the source kind keeps it out of the chat log.
 */
function toNudgeMessage(message: ChatMessage, instruction: string) {
  return createUserMessage({
    content: [{ type: 'text', text: instruction }],
    source: {
      kind: 'qq-proactive',
      userId: message.userId,
      ...(message.groupId === null ? {} : { groupId: message.groupId }),
    },
  })
}

export function toProactiveMessage(message: ChatMessage) {
  return toNudgeMessage(message, '（安静了一会儿。不想说就回 SILENT。）')
}

export function toInterjectMessage(message: ChatMessage, text: string) {
  return toNudgeMessage(message, `群里刚才有人说：「${text}」。不想接就回 SILENT。`)
}

/** She already spoke; these later lines may continue that topic. Not a chat-log message. */
export function toFollowMessage(message: ChatMessage, text: string) {
  return toNudgeMessage(message, `群里刚才还说了这些：\n${text}\n有值得说的就说；没有就回 SILENT。`)
}
