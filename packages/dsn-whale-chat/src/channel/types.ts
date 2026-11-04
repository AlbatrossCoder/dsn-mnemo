/** Minimal OneBot 11 event shapes this channel consumes. */

export interface OneBotSegment {
  readonly type?: string
  readonly data?: {
    readonly text?: string
    readonly qq?: string | number
    readonly [key: string]: unknown
  }
}

export interface OneBotMessageEvent {
  readonly post_type?: string
  readonly message_type?: 'private' | 'group' | string
  readonly self_id?: string | number
  readonly user_id?: string | number
  readonly group_id?: string | number
  readonly message_id?: string | number
  readonly message?: readonly OneBotSegment[] | string
  readonly raw_message?: string
  readonly sender?: { readonly nickname?: string; readonly card?: string }
  readonly time?: number
}

/** Normalized inbound message handed to the bridge. */
export interface ChatMessage {
  readonly kind: 'dm' | 'group'
  readonly userId: string
  readonly groupId: string | null
  readonly messageId: string
  readonly text: string
  readonly mentioned: boolean
  readonly nickname: string | null
  /** Unix seconds, `0` when OneBot did not provide one. */
  readonly at: number
}
