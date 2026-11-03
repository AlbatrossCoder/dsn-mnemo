/**
 * Flatten model-facing content blocks into one searchable string.
 *
 * The raw JSON stays in `messages.raw`; this projection exists only so BM25
 * sees the words a person would search for. Reasoning blocks are deliberately
 * dropped: they are model scratch space, not something worth recalling.
 *
 * @module dsn-mnemo/session/flatten
 */

interface BlockLike {
  readonly type?: unknown
  readonly text?: unknown
  readonly name?: unknown
  readonly arguments?: unknown
}

function textOf(block: BlockLike): string {
  return typeof block.text === 'string' ? block.text : ''
}

/** Convert one content block to text, or `''` when it carries no recallable words. */
function flattenBlock(block: BlockLike): string {
  switch (block.type) {
    case 'text':
      return textOf(block)
    case 'reasoning':
      return ''
    case 'tool-call': {
      // Keep the call visible but drop its arguments: echoing them makes a
      // later recall query match its own call record.
      const name = typeof block.name === 'string' ? block.name : 'unknown'
      return `[call ${name}]`
    }
    case 'image':
      return '[image]'
    case 'file':
      return '[file]'
    default:
      return ''
  }
}

/** Flatten a message's content array into newline-separated text. */
export function flattenContent(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const text = flattenBlock(item as BlockLike)
    if (text.length > 0) parts.push(text)
  }
  return parts.join('\n')
}
