/**
 * Estimated rendered width of a line of highlighted HTML, in monospace `ch`
 * units. Used to size unwrapped (horizontally scrolling) diffs, where
 * virtualized rows can't be measured. Errs wide: tabs count as 4 and anything
 * past U+1100 (CJK, emoji, …) as 2, since overestimating only adds slack.
 */
export function htmlLineWidth(html: string): number {
  const text = html
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, "_");
  let width = 0;
  for (const char of text) {
    width += char === "\t" ? 4 : char.codePointAt(0)! >= 0x1100 ? 2 : 1;
  }
  return width;
}
