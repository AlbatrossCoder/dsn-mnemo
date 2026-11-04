/**
 * Chinese-aware tokenisation shared by the writer and the reader.
 *
 * SQLite's `unicode61` tokenizer treats a whole CJK sentence as one token, so
 * the index and the query must be segmented by the same function. The index
 * stores the segmented form in a `*_seg` column; queries go through
 * {@link buildMatchQuery}, which emits quoted FTS5 terms so punctuation can
 * never be parsed as FTS syntax.
 *
 * @module dsn-mnemo/db/segment
 */

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

/** Tokenise text into space-separated words, dropping whitespace-only pieces. */
export function segment(text: string): string {
  const parts: string[] = []
  for (const piece of segmenter.segment(text)) {
    const token = piece.segment.trim()
    if (token.length === 0) continue
    parts.push(token)
  }
  return parts.join(' ')
}

/** True when a segment is only punctuation/symbols and carries no search value. */
const NOISE = /^[\p{P}\p{S}\s]+$/u

/**
 * Single-character Han words that add noise, not signal, to a query. A whole
 * sentence such as 「我们上次聊了什么」 is mostly these; requiring them all
 * (AND) or letting any of them widen the OR net both drown the real keywords.
 * Keep any token that contains at least one *meaningful* Han character so
 * words like 「难过」 still survive even though 「过」 alone would be dropped.
 */
const QUERY_STOPWORDS = new Set('的了是在我有和就不没都会要你他她它吗呢吧啊很太这那也还个上下着过把被让给对从到说想'.split(''))

/** True when a token deserves a slot in an FTS query. */
function isSearchableToken(token: string): boolean {
  if (token.length === 0 || NOISE.test(token)) return false
  // Drop tokens made entirely of single-character CJK stopwords (的 / 了 / 我们 …);
  // keep anything that carries at least one meaningful character — including
  // Latin words, digits and mixed tokens like `a"b`.
  return ![...token].every((char) => /[\u3400-\u9fff]/u.test(char) && QUERY_STOPWORDS.has(char))
}

/** Segment raw text into meaningful query tokens, dropping filler. */
function queryTokens(text: string): string[] {
  const tokens: string[] = []
  for (const piece of segmenter.segment(text)) {
    const token = piece.segment.trim()
    if (isSearchableToken(token)) tokens.push(token)
  }
  return tokens
}

/**
 * Build an FTS5 MATCH expression from free text (implicit AND).
 *
 * @param text - raw user or model query.
 * @returns a quoted AND query, or `null` when nothing searchable remains.
 */
export function buildMatchQuery(text: string): string | null {
  const tokens = queryTokens(text)
  if (tokens.length === 0) return null
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ')
}

/**
 * Build a quoted OR query, used when the input is a whole sentence: requiring
 * every token (AND) would miss memories that share only part of it.
 *
 * @param text - raw sentence.
 * @returns a quoted OR query, or `null` when nothing searchable remains.
 */
export function buildAnyMatchQuery(text: string): string | null {
  const tokens = queryTokens(text)
  if (tokens.length === 0) return null
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ')
}
