import type { PersonaLayer, Persona, PersonaSample, PersonaToggles } from './personas.js'

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

function renderSamples(samples: readonly PersonaSample[] | undefined): string | undefined {
  if (samples === undefined || samples.length === 0) return undefined
  const lines = ['语气样本（可以参考这些语气，但要贴合当下情境和人设，别机械照搬）：']
  for (const sample of samples) {
    lines.push(`用户：${sample.user}`)
    lines.push(`她：${sample.reply}`)
  }
  return lines.join('\n')
}

/**
 * Assemble the injected persona text.
 *
 * Order: base → base samples → each enabled hidden layer (with its samples) →
 * address override → no-kaomoji rule → user custom. A disabled hidden layer is
 * omitted entirely, so it never reaches the model (saves tokens, leaks nothing).
 */
export function assemblePersona(persona: Persona, options: AssembleOptions): string {
  const parts: string[] = [persona.base]
  const baseSamples = renderSamples(persona.samples)
  if (baseSamples !== undefined) parts.push(baseSamples)
  for (const layer of persona.hidden ?? []) {
    if (!toggleOn(layer, options.toggles)) continue
    parts.push(layer.text)
    const layerSamples = renderSamples(layer.samples)
    if (layerSamples !== undefined) parts.push(layerSamples)
  }
  const address = options.addressUser?.trim()
  if (address !== undefined && address.length > 0) {
    parts.push(`称呼：对主人叫「${address}」；对其他人用「你」或昵称，不要用主人称呼。`)
  }
  parts.push(
    options.toggles.kaomoji
      ? 'emoji 可以正常用，但别每句都加。'
      : '不要使用颜文字（emoji 可以正常用，但别每句都加）。',
  )
  const custom = options.custom?.trim()
  if (custom !== undefined && custom.length > 0) {
    parts.push(custom)
  }
  return parts.join('\n\n')
}
