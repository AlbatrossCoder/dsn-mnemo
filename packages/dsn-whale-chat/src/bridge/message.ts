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
  return toNudgeMessage(message, '（安静了一会儿。不想说就回 SILENT。）')
}

export function toInterjectMessage(message: ChatMessage, text: string) {
  return toNudgeMessage(message, `群里刚才有人说：「${text}」。不想接就回 SILENT。`)
}

/** What this follow-up batch is, relative to the thread she was already on. */
export interface FollowCue {
  /** Lines the group just said, already tagged with speaker. */
  readonly transcript: string
  /** `new` does not reset the fade. Only a direct call does that. */
  readonly relation: 'same' | 'new'
  /** How many follow-up replies she has already made. `0` means she just joined. */
  readonly level: number
}

function fadeLine(level: number): string {
  if (level <= 0) return '你刚接过话。'
  if (level === 1) return '你已经顺着接过一次，话头在淡。'
  return '你已经跟了几轮，这条线淡了。多半不用接，除非真的扯到你。'
}

function threadLine(relation: 'same' | 'new'): string {
  if (relation === 'new') return '群里换了一件事。这仍是跟聊，淡出不重置。'
  return '还是刚才那件事。'
}

/**
 * She already spoke; these later lines may continue that topic.
 * Not a chat-log message. She decides from the cue whether to answer.
 */
export function toFollowMessage(message: ChatMessage, cue: FollowCue) {
  const text = [
    '群里刚才还说了这些：',
    cue.transcript,
    `${fadeLine(cue.level)}${threadLine(cue.relation)}`,
    '没人叫你。按你自己的性子决定接不接：想说就说，不想把这件事续下去就回 SILENT。你停过的话题，别人没换说法、也没叫你，就别绕回去。',
  ].join('\n')
  return toNudgeMessage(message, text)
}
