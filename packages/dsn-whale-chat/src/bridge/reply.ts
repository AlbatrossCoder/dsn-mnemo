import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Concatenate the visible text blocks of one assistant message. */
export function assistantText(content: readonly ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}
