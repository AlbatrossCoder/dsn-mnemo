import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name; must stay stable so profile entries can target it. */
export const name = 'dsn-whale-chat'

/** Services required before `apply` runs. */
export const inject = ['tools', 'sessions', 'systemPrompt']

/** User-facing configuration (skeleton; see docs/chat-plugin.md). */
export const Config = z.object({
  wsUrl: z.string().default('ws://127.0.0.1:3001'),
  accessToken: z.string().default(''),
  activePersona: z.string().default('little-whale'),
  mischief: z.boolean().default(false),
  queen: z.boolean().default(false),
  kaomoji: z.boolean().default(false),
})

export type WhaleChatConfig = Schemastery.TypeT<typeof Config>

/**
 * Mount the QQ chat plugin.
 *
 * This is a skeleton: channel (OneBot), persona (cards + toggles) and rate
 * control land here. No `export default` — the loader's unwrapExports would
 * drop `inject`.
 */
export function apply(_ctx: Context, _config: WhaleChatConfig): void {
  // TODO: wire channel / persona / rate / bridge.
}
