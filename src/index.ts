import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name; must stay stable so profile entries can target it. */
export const name = 'mnemo'

/** Services required before `apply` runs. Grows as later phases land. */
export const inject = ['tools']

/** User-facing configuration (mirrors DESIGN.md §8). */
export const Config = z.object({
  dbPath: z.string().default('~/.dsh/mnemo/mnemo.db'),
  diaryIdleMinutes: z.natural().default(30),
  diaryMaxPerSession: z.natural().default(3),
  anchorWindowDays: z.natural().default(2),
  contextRecallLimit: z.natural().default(3),
})

export type MnemoConfig = Schemastery.TypeT<typeof Config>

const VERSION = '0.1.0'

/**
 * Register the plugin's tools. Phase 0 exposes only `mnemo_ping`, whose sole
 * purpose is proving the loader mounted this module inside the real harness.
 * No `export default`: the loader's unwrapExports would drop `inject`.
 */
export function apply(ctx: Context, config: MnemoConfig) {
  const ping = defineTool({
    name: 'mnemo_ping',
    description:
      'Health check for the mnemo memory plugin. Returns the plugin version and the configured database path.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          pong: { type: 'boolean' },
          version: { type: 'string' },
          dbPath: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `mnemo ${value.version} ok (${value.dbPath})` }],
    },
    async execute() {
      return { pong: true, version: VERSION, dbPath: config.dbPath }
    },
  })

  ctx.tools.register(ping)
}
