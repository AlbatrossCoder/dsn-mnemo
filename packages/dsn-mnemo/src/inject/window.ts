/**
 * Recent-conversation window for proactive recall.
 *
 * A single message is a bad query: people send short bursts ("然后呢", "就那个")
 * and one event may span several messages. This module merges bursts, cuts the
 * window at topic boundaries (adjacent lexical overlap), and returns the
 * keyword query for the segment that contains the latest message.
 *
 * @module dsn-mnemo/inject/window
 */
import { segment } from '../db/segment.js'

/** The slice of a derived message this module needs. */
export interface WindowMessage {
  readonly role?: unknown
  readonly content?: unknown
  readonly source?: { readonly kind?: unknown }
}

export interface TopicQuery {
  /** Text of the selected topic segment (for FTS / debugging). */
  readonly text: string
  /** Informative tokens; empty means "do not search". */
  readonly tokens: readonly string[]
}

export interface WindowOptions {
  /** Hard cap on merged messages considered. */
  readonly maxMessages?: number
  /** Hard cap on query characters (roughly 300 tokens). */
  readonly maxChars?: number
}

const STOPWORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '我们', '你们', '他们',
  '在', '有', '和', '就', '不', '也', '都', '这', '那', '这个', '那个',
  '什么', '怎么', '为什么', '哪', '哪里', '吗', '呢', '啊', '吧', '呀',
  '嗯', '哦', '好', '行', '可以', '然后', '所以', '但是', '而且', '如果',
  '一个', '一下', '一点', '还是', '就是', '没有', '不是',
])

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const value = block as { type?: unknown; text?: unknown }
    if (value.type === 'text' && typeof value.text === 'string') parts.push(value.text)
  }
  return parts.join('\n').trim()
}

interface Entry {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly tokens: readonly string[]
}

function informativeTokens(text: string): string[] {
  return segment(text)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => {
      if (token.length < 2) return false
      if (STOPWORDS.has(token)) return false
      if (/^\d+$/.test(token)) return false
      return true
    })
}

/** Collapse consecutive same-role messages; injected contexts are ignored. */
export function recentEntries(messages: readonly WindowMessage[]): Entry[] {
  const entries: Entry[] = []
  for (const message of messages) {
    const role = message.role === 'user' || message.role === 'assistant' ? message.role : undefined
    if (role === undefined) continue
    if (role === 'user') {
      const kind = message.source?.kind
      if (kind !== 'user' && kind !== 'qq') continue
    }
    const text = textOf(message.content)
    if (text.length === 0) continue
    const previous = entries[entries.length - 1]
    if (previous !== undefined && previous.role === role) {
      const merged = `${previous.text}\n${text}`
      entries[entries.length - 1] = { role, text: merged, tokens: informativeTokens(merged) }
    } else {
      entries.push({ role, text, tokens: informativeTokens(text) })
    }
  }
  return entries
}

function overlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const set = new Set(a)
  let count = 0
  for (const token of new Set(b)) if (set.has(token)) count += 1
  return count
}

/**
 * Pick the topic segment that contains the latest message.
 *
 * Walks backwards while adjacent entries share at least two informative
 * tokens; a segment with too few tokens grows one extra entry so fragments
 * like 「然后呢」 still inherit the previous topic.
 */
export function topicSegment(entries: readonly Entry[], options: WindowOptions = {}): TopicQuery {
  const maxMessages = options.maxMessages ?? 16
  const maxChars = options.maxChars ?? 300
  const recent = entries.slice(-maxMessages)
  if (recent.length === 0) return { text: '', tokens: [] }

  let start = recent.length - 1
  while (start > 0) {
    const left = recent[start - 1]
    const right = recent[start]
    if (left === undefined || right === undefined) break
    if (overlap(left.tokens, right.tokens) >= 2) {
      start -= 1
      continue
    }
    // Too little signal in the segment so far: inherit one more entry so a
    // fragment like 「就上次那家」 still carries the previous topic.
    if (recent.slice(start).flatMap((entry) => entry.tokens).length < 4 && start > 0) {
      start -= 1
      continue
    }
    break
  }

  let segmentEntries = recent.slice(start)
  let text = segmentEntries.map((entry) => entry.text).join('\n')
  // Trim from the oldest side until the character budget fits.
  while (text.length > maxChars && segmentEntries.length > 1) {
    segmentEntries = segmentEntries.slice(1)
    text = segmentEntries.map((entry) => entry.text).join('\n')
  }
  if (text.length > maxChars) text = text.slice(text.length - maxChars)
  return { text, tokens: informativeTokens(text) }
}

/** Build the proactive query from a session's derived messages. */
export function buildProactiveQuery(messages: readonly WindowMessage[], options: WindowOptions = {}): TopicQuery {
  return topicSegment(recentEntries(messages), options)
}
