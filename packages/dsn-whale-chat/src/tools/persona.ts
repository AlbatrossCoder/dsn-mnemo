/**
 * Persona tools: change the name/address/custom layer, switch persona, and
 * flip the hidden-content toggles. They only fire when the user explicitly
 * asks; the model must not rewrite its own core persona.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { findPersona, type Persona } from '../persona/personas.js'
import type { StateStore } from '../persona/state.js'

const stateSchema = {
  type: 'object',
  properties: {
    activeId: { type: 'string' },
    name: { type: 'string' },
    addressUser: { type: 'string' },
    custom: { type: 'string' },
    toggles: {
      type: 'object',
      properties: {
        mischief: { type: 'boolean' },
        queen: { type: 'boolean' },
        kaomoji: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const

function describe(state: { activeId?: string; name?: string; addressUser?: string }): string {
  return `persona: ${state.activeId ?? '-'} (${state.name ?? '-'}, 叫用户「${state.addressUser ?? '-'}」)`
}

export function createPersonaSetTool(store: StateStore) {
  return defineTool({
    name: 'persona_set',
    description:
      'Change the bot\'s personalized layer when the user explicitly asks: its displayed name, how it addresses the user, or an extra setting. Pass reset=true to restore config defaults. Do not use it on your own initiative.',
    parameters: {
      name: { type: 'string', description: 'New displayed name, e.g. 小海豚.' },
      addressUser: { type: 'string', description: 'How she should address the user, e.g. 主人.' },
      custom: { type: 'string', description: 'Extra standing instruction appended to the persona, e.g. 别用颜文字。' },
      reset: { type: 'boolean', description: 'Restore config defaults.' },
    },
    output: {
      schema: stateSchema,
      render: (_args, value) => [{ type: 'text', text: describe(value) }],
    },
    async execute(args) {
      if (args.reset === true) return store.reset()
      const patch: { name?: string; addressUser?: string; custom?: string } = {}
      if (typeof args.name === 'string' && args.name.trim().length > 0) patch.name = args.name.trim()
      if (typeof args.addressUser === 'string' && args.addressUser.trim().length > 0) {
        patch.addressUser = args.addressUser.trim()
      }
      if (typeof args.custom === 'string') patch.custom = args.custom
      return store.update(patch)
    },
  })
}

export function createPersonaSwitchTool(store: StateStore, personas: readonly Persona[]) {
  return defineTool({
    name: 'switch_persona',
    description: 'Switch the active persona between the built-in ones. Use it only when the user asks to switch.',
    parameters: {
      id: { type: 'string', enum: personas.map((persona) => persona.id), description: 'Persona id.', required: true },
    },
    output: {
      schema: stateSchema,
      render: (_args, value) => [{ type: 'text', text: describe(value) }],
    },
    async execute(args) {
      const persona = findPersona(args.id)
      if (persona === undefined) throw new Error(`unknown persona: ${args.id}`)
      return store.update({ activeId: persona.id, name: persona.name })
    },
  })
}

export function createPersonaToggleTool(store: StateStore) {
  return defineTool({
    name: 'persona_toggle',
    description:
      'Flip the hidden-content toggles: mischief (little whale 恶趣味), queen (big whale 女王), kaomoji. Only change them when the user asks.',
    parameters: {
      mischief: { type: 'boolean', description: 'Little whale mischief layer.' },
      queen: { type: 'boolean', description: 'Big whale queen layer.' },
      kaomoji: { type: 'boolean', description: 'Allow kaomoji / emoji.' },
    },
    output: {
      schema: stateSchema,
      render: (_args, value) => [
        {
          type: 'text',
          text: `toggles: mischief=${value.toggles?.mischief ?? false} queen=${value.toggles?.queen ?? false} kaomoji=${value.toggles?.kaomoji ?? false}`,
        },
      ],
    },
    async execute(args) {
      const toggles: { mischief?: boolean; queen?: boolean; kaomoji?: boolean } = {}
      if (typeof args.mischief === 'boolean') toggles.mischief = args.mischief
      if (typeof args.queen === 'boolean') toggles.queen = args.queen
      if (typeof args.kaomoji === 'boolean') toggles.kaomoji = args.kaomoji
      return store.update({ toggles })
    },
  })
}
