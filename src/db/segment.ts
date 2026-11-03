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
 * Build an FTS5 MATCH expression from free text (implicit AND).
 *
 * @param text - raw user or model query.
 * @returns a quoted AND query, or `null` when nothing searchable remains.
 */
export function buildMatchQuery(text: string): string | null {
  const tokens: string[] = []
  for (const piece of segmenter.segment(text)) {
    const token = piece.segment.trim()
    if (token.length === 0 || NOISE.test(token)) continue
    tokens.push(token)
  }
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
  const match = buildMatchQuery(text)
  if (match === null) return null
  return match.split(' ').join(' OR ')
}
