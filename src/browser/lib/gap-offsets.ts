type GapHunk =
  | { type: "skip" }
  | {
      type: "hunk";
      oldStart: number;
      newStart: number;
      lines: { type: string }[];
    };

/**
 * How far new-file line numbers run ahead of old ones in each unchanged gap,
 * indexed like skip blocks, plus one entry for the end-of-file gap. Gap lines
 * are read from the head file, so old = new - offset.
 */
export function gapLineOffsets(hunks: GapHunk[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const hunk of hunks) {
    if (hunk.type === "skip") {
      offsets.push(offset);
      continue;
    }
    const oldCount = hunk.lines.filter((l) => l.type !== "insert").length;
    const newCount = hunk.lines.filter((l) => l.type !== "delete").length;
    // An empty side's start is the line before the hunk.
    const nextOld = hunk.oldStart + (oldCount || 1);
    const nextNew = hunk.newStart + (newCount || 1);
    offset = nextNew - nextOld;
  }
  offsets.push(offset);
  return offsets;
}
