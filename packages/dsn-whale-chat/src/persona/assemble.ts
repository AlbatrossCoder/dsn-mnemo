import type { PersonaLayer, Persona, PersonaToggles } from './personas.js'

export interface AssembleOptions {
  /** Replaces the persona's default address when the user set one. */
  readonly addressUser?: string
  /** User-appended setting, injected last (highest priority). */
  readonly custom?: string
  readonly toggles: PersonaToggles
}

function toggleOn(layer: PersonaLayer, toggles: PersonaToggles): boolean {
  switch (layer.id) {
    case 'mischief':
      return toggles.mischief
    case 'queen':
      return toggles.queen
    case 'troll':
      return toggles.troll
    default:
      return false
  }
}

/**
 * Assemble the injected persona text.
 *
 * Order: base → each enabled hidden layer (in listed order) → address override
 * → no-kaomoji rule → user custom. A disabled hidden layer is omitted entirely,
 * so it never reaches the model (saves tokens, leaks nothing).
 */
export function assemblePersona(persona: Persona, options: AssembleOptions): string {
  const parts: string[] = [persona.base]
  for (const layer of persona.hidden ?? []) {
    if (toggleOn(layer, options.toggles)) parts.push(layer.text)
  }
  const address = options.addressUser?.trim()
  if (address !== undefined && address.length > 0) {
    parts.push(`称呼：叫用户「${address}」。`)
  }
  if (!options.toggles.kaomoji) {
    parts.push('不要使用颜文字和 emoji。')
  }
  const custom = options.custom?.trim()
  if (custom !== undefined && custom.length > 0) {
    parts.push(custom)
  }
  return parts.join('\n\n')
}
