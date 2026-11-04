/**
 * WS transport seam.
 *
 * The client takes a {@link Connect} function so tests can drive a fake socket
 * without a real OneBot server. The default factory uses Node's global
 * `WebSocket` (Node 22+), passing the token as `?access_token=`.
 */

export interface Connection {
  send(data: string): void
  close(): void
}

export interface ConnectHandlers {
  onOpen(): void
  onMessage(data: string): void
  onClose(): void
  onError?(error: unknown): void
}

export type Connect = (url: string, handlers: ConnectHandlers) => Connection

interface WebSocketLike {
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void
  send(data: string): void
  close(): void
}

/** Real transport: Node's global WebSocket, token via `access_token` query. */
export const webSocketConnect: Connect = (url, handlers) => {
  const ctor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
  if (ctor === undefined) throw new Error('global WebSocket is unavailable (requires Node 22+)')
  const socket = new ctor(url)
  socket.addEventListener('open', () => handlers.onOpen())
  socket.addEventListener('message', (event) => {
    handlers.onMessage(typeof event.data === 'string' ? event.data : String(event.data))
  })
  socket.addEventListener('close', () => handlers.onClose())
  socket.addEventListener('error', (event) => handlers.onError?.(event))
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
  }
}
