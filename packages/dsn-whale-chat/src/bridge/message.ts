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
