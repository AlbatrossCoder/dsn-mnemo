import assert from 'node:assert/strict'
import test from 'node:test'
import { buildJudgePrompt, clipTranscript, parseDiaryResponse, renderTranscript } from './judge.js'

const VALID = ['IMPORTANCE: 0.8', 'EMOTION: 0.6', 'TAGS: 日常, 约定', '', '今天和主人聊了记忆系统的设计，聊到很晚。'].join(
  '\n',
)

test('parses a well-formed diary answer', () => {
  const decision = parseDiaryResponse(VALID)
  assert.ok(decision)
  assert.equal(decision.importance, 0.8)
  assert.equal(decision.emotion, 0.6)
  assert.deepEqual(decision.tags, ['日常', '约定'])
  assert.match(decision.content, /记忆系统/)
})

test('NO_DIARY means no diary', () => {
  assert.equal(parseDiaryResponse('NO_DIARY'), null)
  assert.equal(parseDiaryResponse('no_diary'), null)
})

test('an answer without the header is declined', () => {
  assert.equal(parseDiaryResponse('今天聊得很开心。'), null)
  assert.equal(parseDiaryResponse(''), null)
})

test('scores are clamped and default when malformed', () => {
  const decision = parseDiaryResponse(
    ['IMPORTANCE: 3', 'EMOTION: -1', 'TAGS: 测试', '', '这是足够长的一段日记正文内容。'].join('\n'),
  )
  assert.ok(decision)
  assert.equal(decision.importance, 1)
  assert.equal(decision.emotion, 0)
})

test('body shorter than eight characters is declined', () => {
  assert.equal(parseDiaryResponse(['IMPORTANCE: 0.5', 'EMOTION: 0.5', 'TAGS: x', '', '好'].join('\n')), null)
})

test('prompt carries transcript, persona, and the output contract', () => {
  const prompt = buildJudgePrompt({ transcript: 'user: 你好', personaHint: '说话简洁' })
  assert.match(prompt, /NO_DIARY/)
  assert.match(prompt, /IMPORTANCE/)
  assert.match(prompt, /user: 你好/)
  assert.match(prompt, /说话简洁/)
})

test('clipTranscript keeps only a bounded tail', () => {
  const clipped = clipTranscript('a'.repeat(100), 10)
  assert.equal(clipped.length, 10)
  assert.equal(clipTranscript('short', 10), 'short')
})

test('renderTranscript flattens text blocks and skips empty messages', () => {
  const rendered = renderTranscript([
    { role: 'user', content: [{ type: 'text', text: '第一句' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: '思考' }] },
    { role: 'assistant', content: [{ type: 'text', text: '第二句' }] },
  ])
  assert.equal(rendered, 'user: 第一句\nassistant: 第二句')
})
