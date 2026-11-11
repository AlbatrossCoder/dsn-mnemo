/**
 * Whether a group line is still the thread she was on.
 *
 * Word overlap is enough: one shared content word keeps the thread, and a
 * line with almost no content words stays on it too. A line that shares
 * nothing is a new thread. The fade level is not reset for that new thread;
 * only a direct call does that, and the caller clears `declined` itself.
 */

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

const STOPWORDS = new Set([
  '我们', '你们', '他们', '她们', '大家', '自己', '今天', '昨天', '明天', '现在', '刚才', '已经',
  '什么', '怎么', '这个', '那个', '然后', '所以', '但是', '而且', '如果', '还是', '就是', '不是',
  '没有', '可以', '知道', '觉得', '真的', '一下', '一点', '一个',
])

/** How much of the running thread to keep. Older words fall off the front. */
const TOPIC_CHARS = 800

export type TopicRelation = 'same' | 'new' | 'thin'

export interface TopicState {
  readonly text: string
  readonly declined: boolean
}

export interface FollowLook {
  readonly action: 'look'
  readonly relation: 'same' | 'new'
  readonly text: string
}

function contentTokens(text: string): string[] {
  const tokens: string[] = []
  for (const piece of segmenter.segment(text)) {
    const token = piece.segment.trim().toLowerCase()
    if (token.length < 2) continue
    if (STOPWORDS.has(token)) continue
    if (/^[\p{P}\p{S}\d]+$/u.test(token)) continue
    tokens.push(token)
  }
  return tokens
}

/** `thin` lines have too little of their own to count as a new thread. */
export function topicRelation(previous: string, next: string): TopicRelation {
  const incoming = contentTokens(next)
  if (incoming.length < 2) return 'thin'
  const prior = new Set(contentTokens(previous))
  if (prior.size === 0) return 'new'
  for (const token of new Set(incoming)) if (prior.has(token)) return 'same'
  return 'new'
}

function remember(previous: string | undefined, body: string, relation: TopicRelation): string {
  if (relation === 'new' || previous === undefined || previous.length === 0) return body
  if (relation === 'thin') return previous
  const joined = `${previous}\n${body}`
  return joined.length > TOPIC_CHARS ? joined.slice(joined.length - TOPIC_CHARS) : joined
}

/**
 * Decide whether this text is worth a follow-up look.
 *
 * A topic she already left stays dropped until the words change. A new thread
 * is still a follow-up: the caller must not reset the fade.
 */
export function nextTopic(state: TopicState | undefined, body: string): { action: 'drop' } | FollowLook {
  const relation =
    state === undefined || state.text.length === 0
      ? contentTokens(body).length < 2
        ? 'thin'
        : 'new'
      : topicRelation(state.text, body)
  if (state?.declined === true && relation !== 'new') return { action: 'drop' }
  return {
    action: 'look',
    relation: relation === 'new' ? 'new' : 'same',
    text: remember(state?.text, body, relation),
  }
}
