/**
 * Character-level fallback primitives for Chinese retrieval.
 *
 * Segmenter tokens are exact: 「看了海」 indexes as `看了` + `海`, so a query
 * for 「看海」 misses it. When FTS returns nothing, stores fall back to
 * matching meaningful Han characters instead of words.
 *
 * @module dsn-mnemo/db/char-search
 */

/** Characters that carry no retrieval value on their own. */
export const CJK_STOPWORDS = new Set(
  '的了是在我有和就不没都会要你他她它吗呢吧啊很太这那也还个上下着过把被让给对从到说想'.split(''),
)

/** Distinct meaningful Han characters in a query, capped for selectivity. */
export function cjkChars(query: string, max = 8): string[] {
  const unique = [...new Set([...query].filter((char) => /\p{Script=Han}/u.test(char) && !CJK_STOPWORDS.has(char)))]
  return unique.slice(0, max)
}

/**
 * Rank assigned to character-fallback hits so that, when mixed with FTS5
 * results, they sort *after* real BM25 matches instead of before them. BM25
 * ranks are negative (lower is better); this large positive constant makes a
 * fallback hit the worst BM25 candidate while still carrying a finite score.
 */
export const CHAR_FALLBACK_RANK = 1_000_000

/** Hard cap on how many newest rows the character fallback may inspect. */
export const CHAR_FALLBACK_SCAN_LIMIT = 2000
