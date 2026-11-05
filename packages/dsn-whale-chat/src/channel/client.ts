/**
 * OneBot 11 client: connect, dedupe inbound messages, reconnect with backoff,
 * send replies.
 *
 * The transport is injectable so the whole client can be tested against a fake
 * socket (no NapCat / OneBot server needed).
 */
import { createDedupe } from './dedupe.js'
import { parseEvent } from './parse.js'
import { webSocketConnect, type Connect, type Connection } from './transport.js'
import type { ChatMessage } from './types.js'

export interface ClientOptions {
  /** OneBot 11 WS endpoint, e.g. `ws://127.0.0.1:3001`. */
  readonly url: string
  /** Optional access token; appended as `?access_token=`. */
  readonly token?: string
  /** Transport seam; defaults to the real Node `WebSocket`. */
  readonly connect?: Connect
  readonly onMessage: (message: ChatMessage) => void
  readonly onError?: (error: unknown) => void
  /** Backoff base delay, default 1000ms. */
  readonly reconnectBaseMs?: number
  /** Backoff cap, default 30000ms. */
  readonly reconnectMaxMs?: number
}

export class OneBotClient {
  private readonly connect: Connect
  private readonly isNewMessage = createDedupe()
  private connection: Connection | null = null
  private open = false
  private stopped = true
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private echo = 0
  /** Last inbound frame of any kind; a silent socket gets reconnected. */
  private lastFrameAt = 0
  private watchdog: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: ClientOptions) {
    this.connect = options.connect ?? webSocketConnect
  }

  get connected(): boolean {
    return this.open
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.openSocket()
    this.watchdog = setInterval(() => this.checkAlive(), 30_000)
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.watchdog !== null) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
    this.connection?.close()
    this.connection = null
    this.open = false
  }

  /**
   * A half-open socket can keep the TCP connection but stop delivering
   * messages. If nothing at all arrives for a while, reconnect.
   */
  private checkAlive(): void {
    if (!this.open || this.connection === null) return
    if (Date.now() - this.lastFrameAt > 90_000) {
      this.connection.close()
    }
  }

  /** Send a raw OneBot action. Throws when not connected. */
  send(action: string, params: Record<string, unknown>): void {
    if (this.connection === null) throw new Error('onebot client is not connected')
    this.connection.send(JSON.stringify({ action, params, echo: String(++this.echo) }))
  }

  sendPrivate(userId: string, text: string): void {
    this.send('send_private_msg', { user_id: Number(userId), message: [{ type: 'text', data: { text } }] })
  }

  sendGroup(groupId: string, text: string): void {
    this.send('send_group_msg', { group_id: Number(groupId), message: [{ type: 'text', data: { text } }] })
  }

  /**
   * Best-effort private-chat typing status (NapCat supports it; SnowLuma and
   * older backends may not). Failures are ignored on purpose — a typing hint
   * must never spam the error log or block the reply.
   */
  setInputStatus(userId: string): void {
    try {
      this.send('set_input_status', { user_id: Number(userId), event_type: 1 })
    } catch {
      // Optional capability; ignore.
    }
  }

  private openSocket(): void {
    if (this.stopped) return
    try {
      this.connection = this.connect(this.tokenizedUrl(), {
        onOpen: () => {
          this.open = true
          this.attempt = 0
          this.lastFrameAt = Date.now()
        },
        onMessage: (data) => this.handle(data),
        onClose: () => this.handleClose(),
        onError: (error) => this.options.onError?.(error),
      })
    } catch (error) {
      // A synchronous connect failure (bad URL, missing WebSocket) still retries.
      this.options.onError?.(error)
      this.connection = null
      this.handleClose()
    }
  }

  private tokenizedUrl(): string {
    const token = this.options.token?.trim()
    if (token === undefined || token.length === 0) return this.options.url
    const separator = this.options.url.includes('?') ? '&' : '?'
    return `${this.options.url}${separator}access_token=${encodeURIComponent(token)}`
  }

  private handle(data: string): void {
    this.lastFrameAt = Date.now()
    const message = parseEvent(data)
    if (message === null) return
    if (!this.isNewMessage(message.messageId)) return
    try {
      this.options.onMessage(message)
    } catch (error) {
      this.options.onError?.(error)
    }
  }

  private handleClose(): void {
    this.open = false
    this.connection = null
    if (this.stopped) return
    const base = this.options.reconnectBaseMs ?? 1000
    const max = this.options.reconnectMaxMs ?? 30_000
    const delay = Math.min(max, base * 2 ** this.attempt)
    this.attempt += 1
    this.timer = setTimeout(() => {
      this.timer = null
      this.openSocket()
    }, delay)
  }
}
