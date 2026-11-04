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

/** Build the identified user message the agent will receive. */
export function toUserMessage(message: ChatMessage) {
  return createUserMessage({
    content: [{ type: 'text', text: message.text }],
    source: {
      kind: 'qq',
      userId: message.userId,
      ...(message.groupId === null ? {} : { groupId: message.groupId }),
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
  return toNudgeMessage(
    message,
    '（现在没有新消息。你可以主动说一句：如果想起了什么、有没聊完的话题、或到日子的锚点，就说；没有想说的就只回复 SILENT。）',
  )
}

export function toInterjectMessage(message: ChatMessage, text: string) {
  return toNudgeMessage(message, `群里刚才有人说：「${text}」。你可以接一句，或回 SILENT。`)
}
