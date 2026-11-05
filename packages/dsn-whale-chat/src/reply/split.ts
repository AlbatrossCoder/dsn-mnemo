/**
 * Turn one model reply into QQ messages.
 *
 * A newline the model wrote is one message. A fenced code block stays in a
 * single message so its lines are not sent one by one. A single message that
 * exceeds the platform limit is cut on a sentence boundary. The whole reply
 * stops at the send cap; the rest is not sent.
 */

export const PLATFORM_MAX_CHARS = 4500
export const REPLY_MAX_CHARS = 800

export interface SplitOptions {
  readonly platformMaxChars?: number
  readonly replyMaxChars?: number
}

/** Short lines wait in this band; longer lines wait in the next one. */
const SHORT_CHARS = 20

/**
 * Per-message pause before that message is sent.
 *
 * Short text lands between 1.5s and 2.5s. Longer text lands between 2.5s and
 * 4s. The length only picks the band.
 */
export function typingDelay(text: string, random: () => number = Math.random): number {
  const short = text.length <= SHORT_CHARS
  const min = short ? 1500 : 2500
  const max = short ? 2500 : 4000
  const span = max - min
  return min + Math.floor(Math.max(0, Math.min(0.999999, random())) * (span + 1))
}

/** Split one reply into the messages that will actually be sent. */
export function splitReply(text: string, options: SplitOptions = {}): string[] {
  const platform = options.platformMaxChars ?? PLATFORM_MAX_CHARS
  const replyMax = options.replyMaxChars ?? REPLY_MAX_CHARS
  const trimmed = text.trim()
  if (trimmed.length === 0 || platform <= 0 || replyMax <= 0) return []

  const pieces: string[] = []
  for (const part of splitPreservingFences(trimmed)) {
    if (part.length <= platform) pieces.push(part)
    else pieces.push(...splitLong(part, platform))
  }
  return capTotal(pieces, replyMax)
}

function splitPreservingFences(text: string): string[] {
  const parts: string[] = []
  const re = /```[\s\S]*?```/g
  let last = 0
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0
    parts.push(...splitLines(text.slice(last, index)))
    const block = match[0].trim()
    if (block.length > 0) parts.push(block)
    last = index + match[0].length
  }
  parts.push(...splitLines(text.slice(last)))
  return parts
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function splitLong(paragraph: string, max: number): string[] {
  const chunks: string[] = []
  let current = ''
  const sentences = paragraph.split(/(?<=[。！？!?；;…])/)
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
      const slice = sentence.slice(index, index + max).trim()
      if (slice.length > 0) chunks.push(slice)
    }
  }
  if (current.trim().length > 0) chunks.push(current.trim())
  return chunks
}

function capTotal(chunks: readonly string[], max: number): string[] {
  const out: string[] = []
  let used = 0
  for (const chunk of chunks) {
    if (used >= max) break
    if (used + chunk.length <= max) {
      out.push(chunk)
      used += chunk.length
      continue
    }
    if (out.length === 0) {
      const slice = chunk.slice(0, max).trim()
      if (slice.length > 0) out.push(slice)
    }
    break
  }
  return out
}
