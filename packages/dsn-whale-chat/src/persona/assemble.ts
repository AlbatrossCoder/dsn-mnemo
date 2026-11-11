import type { PersonaLayer, Persona, PersonaSample, PersonaToggles } from './personas.js'

export interface AssembleOptions {
  /** Current display name (owner-given); falls back to the persona card name. */
  readonly displayName?: string
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

/** Render life fragments as rhythm anchors, not answer keys. */
export function formatSamples(samples: readonly PersonaSample[], speaker = '小鲸鱼'): string {
  if (samples.length === 0) return ''
  const blocks = samples.map((sample) => `对方：${sample.user}\n${speaker}：${sample.reply}`)
  return `【相处片段】（节奏参考，不是标准答案；也可以接歪、说半句）\n${blocks.join('\n\n')}`
}

/**
 * Assemble the injected persona text.
 *
 * Order: base → samples → each enabled hidden layer (+ its samples) → address
 * override → no-kaomoji rule → user custom. A disabled hidden layer is omitted.
 */
export function assemblePersona(persona: Persona, options: AssembleOptions): string {
  const speaker =
    options.displayName !== undefined && options.displayName.trim().length > 0
      ? options.displayName.trim()
      : persona.name
  const parts: string[] = [persona.base]
  if (speaker !== persona.name) {
    parts.push(`现在别人喊你「${speaker}」。`)
  }
  const baseSamples = formatSamples(persona.samples ?? [], speaker)
  if (baseSamples.length > 0) parts.push(baseSamples)
  for (const layer of persona.hidden ?? []) {
    if (!toggleOn(layer, options.toggles)) continue
    parts.push(layer.text)
    const layerSamples = formatSamples(layer.samples ?? [], speaker)
    if (layerSamples.length > 0) parts.push(layerSamples)
  }
  const address = options.addressUser?.trim()
  if (address !== undefined && address.length > 0) {
    parts.push(`称呼：对主人叫「${address}」；对其他人用「你」或昵称，不要用主人称呼。`)
  }
  if (!options.toggles.kaomoji) parts.push('不要使用颜文字。')
  const custom = options.custom?.trim()
  if (custom !== undefined && custom.length > 0) parts.push(custom)
  return parts.join('\n\n')
}
