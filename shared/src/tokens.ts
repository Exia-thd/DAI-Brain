/**
 * Token estimation, deliberately approximate.
 *
 * The packer needs a number it can compute thousands of times per request
 * without a tokenizer download, and it needs to never *under*-count, because an
 * under-count is a prompt that exceeds the budget it promised. So this errs
 * high: ~3.4 characters per token against the ~3.7 English average, and CJK
 * counted per character since those rarely merge into multi-character tokens.
 */

const CJK = /[　-鿿가-힯＀-￯]/u;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 3.4);
}

/** Truncates on a word boundary when it can, and always fits the budget. */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  const cut = text.slice(0, lo);
  const space = cut.lastIndexOf(' ');
  return (space > lo * 0.6 ? cut.slice(0, space) : cut).trimEnd();
}
