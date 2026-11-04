/**
 * OneBot 11 event parsing: turn a raw WS frame into a normalized {@link ChatMessage}.
 *
 * Only `post_type === 'message'` events are conversation; everything else
 * (heartbeats, lifecycle, notices) is ignored here.
 */
import type { ChatMessage, OneBotMessageEvent, OneBotSegment } from './types.js'

function asId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function textOf(message: readonly OneBotSegment[] | string | undefined): string {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  const parts: string[] = []
  for (const segment of message) {
    if (segment.type === 'text' && typeof segment.data?.text === 'string') parts.push(segment.data.text)
  }
  return parts.join('')
}

function mentionsSelf(message: readonly OneBotSegment[] | string | undefined, selfId: string | null): boolean {
  if (selfId === null || !Array.isArray(message)) return false
  for (const segment of message) {
    if (segment.type === 'at' && asId(segment.data?.qq) === selfId) return true
  }
  return false
}

/** Parse one frame; returns `null` when it is not a routable message event. */
export function parseEvent(raw: string): ChatMessage | null {
  let event: OneBotMessageEvent
  try {
    event = JSON.parse(raw) as OneBotMessageEvent
  } catch {
    return null
  }
  if (typeof event !== 'object' || event === null || event.post_type !== 'message') return null
  const messageType = event.message_type
  if (messageType !== 'private' && messageType !== 'group') return null

  const userId = asId(event.user_id)
  const messageId = asId(event.message_id)
  if (userId === null || messageId === null) return null

  const isGroup = messageType === 'group'
  const groupId = asId(event.group_id)
  if (isGroup && groupId === null) return null

  return {
    kind: isGroup ? 'group' : 'dm',
    userId,
    groupId: isGroup ? groupId : null,
    messageId,
    text: textOf(event.message),
    mentioned: mentionsSelf(event.message, asId(event.self_id)),
    nickname: event.sender?.card ?? event.sender?.nickname ?? null,
    at: typeof event.time === 'number' ? event.time : 0,
  }
}
