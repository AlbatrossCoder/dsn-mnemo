/**
 * The diary judgement prompt and its parser.
 *
 * One short call decides whether a finished conversation deserves a diary.
 * The model answers either `NO_DIARY` or a small header block plus 2–3
 * first-person sentences; the parser never throws on a malformed answer, it
 * just declines to write.
 *
 * @module dsn-mnemo/diary/judge
 */
import { flattenContent } from '../session/flatten.js'

export interface DiaryDecision {
  readonly content: string
  readonly importance: number
  readonly emotion: number
  readonly tags: readonly string[]
  /** Short-lived memory points distilled alongside the diary. */
  readonly points: readonly string[]
  /** `secret` is a hard filter for group contexts; null means scene default. */
  readonly sensitivity: 'public' | 'private' | 'secret' | null
}

export interface JudgeInput {
  /** Rendered transcript lines, oldest first. */
  readonly transcript: string
  /** Optional persona flavour, never identity rules. */
  readonly personaHint?: string
}

const MAX_TRANSCRIPT_CHARS = 2400

/** Trim a transcript to a bounded tail so the call stays cheap. */
export function clipTranscript(text: string, max = MAX_TRANSCRIPT_CHARS): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(trimmed.length - max)
}

/** Build the single user message sent to the judging model. */
export function buildJudgePrompt(input: JudgeInput): string {
  const persona = input.personaHint?.trim()
  const parts = [
    '你是一个记忆整理器。下面是一段对话记录（可能不完整）。',
    '请判断它是否值得写入长期记忆。',
    '',
    '值得写：发生了具体的事、情绪变化、明确的约定、对关系有意义的互动。',
    '不值得写：纯工具调用、客套、重复问答、没有信息量的寒暄。',
    '',
    '如果值得，用第一人称写 2–3 句日记（不超过 80 字），只写确实发生过的内容，不要推测。',
    '输出格式（严格）：',
    'IMPORTANCE: <0-1 的小数>',
    'EMOTION: <0-1 的小数>',
    'TAGS: <逗号分隔的 1-3 个标签>',
    'POINTS: <0-3 条短期记忆点，用「；」分隔，每条不超过 40 字；没有就写 NONE>',
    'SENSITIVITY: <public|private|secret；默认按场景，明确是秘密才写 secret>',
    '',
    '<日记正文>',
    '',
    '如果不值得，只输出：NO_DIARY',
  ]
  if (persona !== undefined && persona.length > 0) {
    parts.push('', `人设提示：${persona}`)
  }
  parts.push('', '对话记录：', clipTranscript(input.transcript))
  return parts.join('\n')
}

function toUnit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(1, Math.max(0, parsed))
}

/**
 * Parse the judging model's answer.
 *
 * @returns the diary to write, or `null` when the model declined or the answer
 *   could not be understood.
 */
export function parseDiaryResponse(text: string): DiaryDecision | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  if (/^NO_DIARY\b/i.test(trimmed)) return null
  if (!/IMPORTANCE\s*:/i.test(trimmed)) {
    // Without the header we cannot score the entry; treat it as a decline.
    return null
  }

  const importance = toUnit(/IMPORTANCE\s*:\s*(-?[0-9]*\.?[0-9]+)/i.exec(trimmed)?.[1], 0.5)
  const emotion = toUnit(/EMOTION\s*:\s*(-?[0-9]*\.?[0-9]+)/i.exec(trimmed)?.[1], 0.5)
  const tagsRaw = /TAGS\s*:\s*(.+)/i.exec(trimmed)?.[1] ?? ''
  const tags = tagsRaw
    .split(/[,，、\s]+/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .slice(0, 3)

  const pointsRaw = /POINTS\s*:\s*(.+)/i.exec(trimmed)?.[1] ?? ''
  const points = /^NONE$/i.test(pointsRaw.trim())
    ? []
    : pointsRaw
        .split(/[；;]/)
        .map((point) => point.trim())
        .filter((point) => point.length > 0 && !/^NONE$/i.test(point))
        .slice(0, 3)

  const sensitivityRaw = (/SENSITIVITY\s*:\s*(public|private|secret)/i.exec(trimmed)?.[1] ?? '').toLowerCase()
  const sensitivity =
    sensitivityRaw === 'public' || sensitivityRaw === 'private' || sensitivityRaw === 'secret'
      ? (sensitivityRaw as 'public' | 'private' | 'secret')
      : null

  const body = trimmed
    .split('\n')
    .filter((line) => !/^\s*(IMPORTANCE|EMOTION|TAGS|POINTS|SENSITIVITY)\s*:/i.test(line))
    .join('\n')
    .trim()

  if (body.length < 8) return null
  return { content: body, importance, emotion, tags, points, sensitivity }
}

/** Render the last turns of a session as `role: text` lines. */
export function renderTranscript(
  messages: readonly { role: string; content: unknown }[],
  limit = 12,
): string {
  return messages
    .slice(-limit)
    .map((message) => {
      const text = flattenContent(Array.isArray(message.content) ? message.content : [])
      if (text.length === 0) return undefined
      return `${message.role}: ${text}`
    })
    .filter((line): line is string => line !== undefined)
    .join('\n')
}
