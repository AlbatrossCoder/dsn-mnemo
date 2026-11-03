/**
 * Flatten model-facing content blocks into the chat text L0 stores.
 *
 * L0 is a record of what was **said**, not of how the model worked: reasoning
 * and tool calls are model machinery, and tool results are not conversation.
 * They are dropped here, so a message that contains no visible text (a pure
 * tool call) produces an empty string and the recorder skips it.
 *
 * @module dsn-mnemo/session/flatten
 */

interface BlockLike {
  readonly type?: unknown
  readonly text?: unknown
}

function textOf(block: BlockLike): string {
  return typeof block.text === 'string' ? block.text : ''
}

/** Convert one content block to chat text, or `''` when it is not conversation. */
function flattenBlock(block: BlockLike): string {
  switch (block.type) {
    case 'text':
      return textOf(block)
    case 'image':
      return '[image]'
    case 'file':
      return '[file]'
    // Reasoning is thinking; tool-call blocks are machinery; tool results are
    // logged as their own role and skipped by the recorder.
    case 'reasoning':
    case 'tool-call':
    default:
      return ''
  }
}

/** Flatten a message's content array into newline-separated chat text. */
export function flattenContent(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const text = flattenBlock(item as BlockLike)
    if (text.length > 0) parts.push(text)
  }
  return parts.join('\n')
}
