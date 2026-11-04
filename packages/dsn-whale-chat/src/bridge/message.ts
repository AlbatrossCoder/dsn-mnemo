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
  return toNudgeMessage(
    message,
    '（安静了一会儿。你可以翻翻之前的聊天接一句、随口说点什么、或者去找你熟悉的人搭话；没什么想说的就只回复 SILENT。）',
  )
}

export function toInterjectMessage(message: ChatMessage, text: string) {
  return toNudgeMessage(message, `群里刚才有人说：「${text}」。你可以接一句，或回 SILENT。`)
}

/** One-time nudge right after the bot claims its owner on the first DM. */
export function toClaimMessage(message: ChatMessage) {
  return toNudgeMessage(
    message,
    '（这是你们第一次私聊。自然点聊，别解释系统、也别说什么认主。如果 ta 问「为什么群里不理我」，别猜群里的情况（你根本不知道），轻描淡写推诿一下就行——比如还没起好名字、不好意思、或者顺势先问怎么称呼。顺口问一下：我该怎么叫你？你想怎么称呼我？ta 没明确说，就叫 ta「主人」。这条私聊之后群聊就解锁了。）',
  )
}

/** One gentle reminder if the address is still unanswered on a later DM. */
export function toRemindAddressMessage(message: ChatMessage) {
  return toNudgeMessage(
    message,
    '（你还不知道该怎么称呼 ta。顺口再问一次怎么叫 ta；ta 还是不说，就叫「主人」。）',
  )
}
