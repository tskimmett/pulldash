/**
 * Minimal parsing of GitHub `patch` strings (from the pulls/{n}/files API)
 * into hunk line spans. Used for semantic-review coverage math only — the
 * full diff rendering pipeline has its own richer parser.
 */

export interface PatchHunk {
  /** 0-based hunk index within the file's patch. */
  index: number;
  /** Full hunk span on the new side (includes context lines). */
  newStart: number;
  newEnd: number;
  /** Full hunk span on the old side (includes context lines). */
  oldStart: number;
  oldEnd: number;
  /** Span of added lines on the new side, or null if the hunk only deletes. */
  changedNew: { start: number; end: number } | null;
  /** Span of removed lines on the old side, or null if the hunk only adds. */
  changedOld: { start: number; end: number } | null;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatchHunks(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  const lines = patch.split("\n");

  let i = 0;
  while (i < lines.length) {
    const match = HUNK_HEADER_RE.exec(lines[i]!);
    if (!match) {
      i++;
      continue;
    }
    const oldStart = parseInt(match[1]!, 10);
    const oldLines = match[2] !== undefined ? parseInt(match[2]!, 10) : 1;
    const newStart = parseInt(match[3]!, 10);
    const newLines = match[4] !== undefined ? parseInt(match[4]!, 10) : 1;

    let oldLine = oldStart;
    let newLine = newStart;
    let addedMin = Infinity;
    let addedMax = -Infinity;
    let removedMin = Infinity;
    let removedMax = -Infinity;

    i++;
    while (i < lines.length && !HUNK_HEADER_RE.test(lines[i]!)) {
      const line = lines[i]!;
      const prefix = line[0];
      if (prefix === "+") {
        addedMin = Math.min(addedMin, newLine);
        addedMax = Math.max(addedMax, newLine);
        newLine++;
      } else if (prefix === "-") {
        removedMin = Math.min(removedMin, oldLine);
        removedMax = Math.max(removedMax, oldLine);
        oldLine++;
      } else if (prefix === " " || line === "") {
        oldLine++;
        newLine++;
      }
      // "\ No newline at end of file" advances neither side.
      i++;
    }

    hunks.push({
      index: hunks.length,
      newStart,
      newEnd: Math.max(newStart, newStart + newLines - 1),
      oldStart,
      oldEnd: Math.max(oldStart, oldStart + oldLines - 1),
      changedNew:
        addedMax >= addedMin ? { start: addedMin, end: addedMax } : null,
      changedOld:
        removedMax >= removedMin
          ? { start: removedMin, end: removedMax }
          : null,
    });
  }

  return hunks;
}
