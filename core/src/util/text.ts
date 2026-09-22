/** Text handling shared by linking, dedupe and the FTS branch. */

/**
 * Case-folded, accent-stripped, punctuation-collapsed.
 *
 * The accent stripping is what makes this usable for a Vietnamese store: NFD
 * splits `ế` into `e` + combining marks, and dropping the marks makes
 * "kiến trúc" and "kien truc" the same key. It loses the distinction between
 * genuinely different Vietnamese words, which is the accepted cost of matching
 * text typed without diacritics -- how people actually type queries.
 */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'it', 'this',
  'that', 'these', 'those', 'i', 'you', 'we', 'they', 'what', 'which', 'how',
  'do', 'does', 'did', 'can', 'will', 'would', 'should',
  // Vietnamese, in the same normalised (accent-free) form the tokenizer emits.
  'la', 'cua', 'va', 'co', 'khong', 'duoc', 'cho', 'nao', 'gi', 'the', 'nay',
  'mot', 'cac', 'nhung', 'trong', 'voi', 'thi', 'ra', 've', 'tai', 'minh',
]);

export function tokenize(text: string): string[] {
  return normalize(text).split(' ').filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Distinct tokens, for the cheap lexical overlap the entity linker uses. */
export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Builds a `websearch_to_tsquery` input from a free-form question.
 *
 * `websearch_to_tsquery` rather than `to_tsquery`, because the latter is a
 * parser for an operator syntax and raises on anything that is not one -- which
 * a user's question never is. The websearch form takes the words as written,
 * understands a bare `or`, and cannot be made to throw by punctuation.
 *
 * OR rather than AND: a question is not a boolean query, and requiring every
 * content word means a five-word question matches nothing. Fusion handles the
 * precision -- this branch is asked for recall.
 */
export function toTsQuery(query: string): string {
  const tokens = tokenize(query).slice(0, 24);
  return tokens.join(' or ');
}

/** A one-line snippet centred on the first query token that appears. */
export function snippet(content: string, query: string, maxChars = 240): string {
  const flat = content.replace(/\s+/gu, ' ').trim();
  if (flat.length <= maxChars) return flat;
  const needles = tokenize(query);
  const haystack = normalize(flat);
  let at = -1;
  for (const needle of needles) {
    const found = haystack.indexOf(needle);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at === -1) return `${flat.slice(0, maxChars - 1)}…`;
  const start = Math.max(0, at - Math.floor(maxChars / 3));
  const end = Math.min(flat.length, start + maxChars);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}
