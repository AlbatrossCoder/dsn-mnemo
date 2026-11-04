/**
 * Split one model reply into several QQ messages **only when it is too long**.
 *
 * 20/30 chars is a cap, not a target: a one-word reply stays one message. A
 * `【长】` marker or a fenced code block means "special scenario, no char
 * limit": the answer is sent whole.
 */

export interface ReplySplitOptions {
  readonly groupMaxChars: number
  readonly privateMaxChars: number
}

const LONG_MARKER = '【长】'

export function splitReply(text: string, kind: 'group' | 'dm', options: ReplySplitOptions): string[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []

  const longForm = trimmed.startsWith(LONG_MARKER) || trimmed.includes('```')
  if (longForm) {
    const body = trimmed.startsWith(LONG_MARKER) ? trimmed.slice(LONG_MARKER.length).trim() : trimmed
    return body.length > 0 ? [body] : []
  }

  const max = kind === 'group' ? options.groupMaxChars : options.privateMaxChars
  const chunks: string[] = []
  // Every newline is a message boundary the model chose; the char cap only
  // guards a single over-long line.
  for (const paragraph of trimmed.split(/\n/)) {
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
