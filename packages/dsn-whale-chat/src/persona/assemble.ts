import type { Persona, PersonaToggles } from './personas.js'

export interface AssembleOptions {
  /** Replaces the persona's default address when the user set one. */
  readonly addressUser?: string
  /** User-appended setting, injected last (highest priority). */
  readonly custom?: string
  readonly toggles: PersonaToggles
}

function hiddenEnabled(id: string, toggles: PersonaToggles): boolean {
  if (id === 'little-whale') return toggles.mischief
  if (id === 'big-whale') return toggles.queen
  return false
}

/**
 * Assemble the injected persona text.
 *
 * Order: base → hidden (only when its toggle is on) → address override →
 * no-kaomoji rule → user custom. The hidden layer is *omitted entirely* when
 * its toggle is off, so it never reaches the model (saves tokens, leaks nothing).
 */
export function assemblePersona(persona: Persona, options: AssembleOptions): string {
  const parts: string[] = [persona.base]
  if (hiddenEnabled(persona.id, options.toggles) && persona.hidden !== undefined) {
    parts.push(persona.hidden)
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
