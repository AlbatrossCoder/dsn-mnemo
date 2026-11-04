/**
 * Split one model reply into several QQ messages, so the bot talks in short
 * bursts like a person instead of one wall of text.
 *
 * `【长】` or a fenced code block marks a long-form answer: it is split at the
 * much larger `longFormMaxChars` (or kept atomic for code), not at 20/30 chars.
 */

export interface ReplySplitOptions {
  readonly groupMaxChars: number
  readonly privateMaxChars: number
  readonly longFormMaxChars: number
}

const LONG_MARKER = '【长】'

export function splitReply(text: string, kind: 'group' | 'dm', options: ReplySplitOptions): string[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []

  const longForm = trimmed.startsWith(LONG_MARKER) || trimmed.includes('```')
  const body = trimmed.startsWith(LONG_MARKER) ? trimmed.slice(LONG_MARKER.length).trim() : trimmed
  const max = longForm
    ? options.longFormMaxChars
    : kind === 'group'
      ? options.groupMaxChars
      : options.privateMaxChars

  const chunks: string[] = []
  for (const paragraph of body.split(/\n{2,}/)) {
    const clean = paragraph.trim()
    if (clean.length === 0) continue
    if (clean.length <= max) {
      chunks.push(clean)
      continue
    }
    chunks.push(...splitLong(clean, max))
  }
  return chunks
}

function splitLong(paragraph: string, max: number): string[] {
  // A fenced code block is sent whole rather than shredded mid-fence.
  if (paragraph.includes('```')) return [paragraph]

  const chunks: string[] = []
  let current = ''
  const sentences = paragraph.split(/(?<=[。！？!?；;…\n])/)
  for (const sentence of sentences) {
    if (sentence.length === 0) continue
    if (current.length + sentence.length <= max) {
      current += sentence
      continue
    }
    if (current.trim().length > 0) chunks.push(current.trim())
    current = ''
    if (sentence.length <= max) {
      current = sentence
      continue
    }
    for (let index = 0; index < sentence.length; index += max) {
      chunks.push(sentence.slice(index, index + max).trim())
    }
  }
  if (current.trim().length > 0) chunks.push(current.trim())
  return chunks.filter((chunk) => chunk.length > 0)
}
