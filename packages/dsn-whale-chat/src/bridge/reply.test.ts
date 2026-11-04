import assert from 'node:assert/strict'
import test from 'node:test'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assistantText } from './reply.js'

test('assistantText concatenates visible text and ignores other blocks', () => {
  const content: ContentBlock[] = [
    { type: 'text', text: '第一句。' },
    { type: 'reasoning', text: 'thinking' },
    { type: 'text', text: '第二句。' },
  ]
  assert.equal(assistantText(content), '第一句。第二句。')
})

test('assistantText is empty when there is no visible text', () => {
  assert.equal(assistantText([]), '')
  assert.equal(assistantText([{ type: 'reasoning', text: 'x' }]), '')
})
