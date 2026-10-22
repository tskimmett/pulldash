import type { DiffLine } from "./diff-worker";

/** Lines of context GitHub shows above a review comment's line range. */
const CONTEXT_LINES = 4;

/**
 * Trim a review comment's diff hunk to the commented range plus a few lines
 * of context. GitHub's `diffHunk` runs from the top of the hunk down to the
 * commented line, so a comment deep in a new file carries hundreds of lines.
 *
 * The hunk always ends at the commented line (as of the commit the comment
 * was made on), so anchor on the end rather than the current `line`, which
 * is null for outdated comments and can drift from the hunk's numbering.
 * `originalStartLine` (same numbering as the hunk) extends the range for
 * multi-line comments.
 */
export function commentContextLines(
  lines: DiffLine[],
  originalStartLine: number | null
): DiffLine[] {
  if (lines.length === 0) return lines;

  const last = lines[lines.length - 1];
  const onOldSide = last.type === "delete";
  const sideLineNumber = (line: DiffLine) =>
    onOldSide
      ? line.type !== "insert"
        ? line.oldLineNumber
        : undefined
      : line.type !== "delete"
        ? line.newLineNumber
        : undefined;

  let startIndex = lines.length - 1;
  if (originalStartLine != null) {
    const index = lines.findLastIndex(
      (line) => sideLineNumber(line) === originalStartLine
    );
    if (index >= 0) startIndex = index;
  }

  return lines.slice(Math.max(0, startIndex - CONTEXT_LINES));
}
