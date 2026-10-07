import type {
  Change as _Change,
  DeleteChange,
  InsertChange,
  NormalChange,
} from "gitdiff-parser";
import { DefaultLinesDiffComputer, type LinesDiff } from "vscode-diff";

export interface RawLineSegment {
  value: string;
  type: "insert" | "delete" | "normal";
}

type ReplaceKey<T, K extends PropertyKey, V> = T extends unknown
  ? Omit<T, K> & Record<K, V>
  : never;

export type Line = ReplaceKey<_Change, "content", RawLineSegment[]>;

const changeToLine = (change: _Change): Line => ({
  ...change,
  content: [{ value: change.content, type: "normal" }],
});

// VS Code's diff algorithm (DefaultLinesDiffComputer), used to align the
// delete/insert lines of each change block and compute character-level
// inner changes - the same output VS Code renders in its diff editor.
const linesDiffComputer = new DefaultLinesDiffComputer();

/** 0-based line index -> [startColumn, endColumn) pairs (1-based columns). */
type EmphasisRanges = Map<number, Array<[number, number]>>;

/** Split a (possibly multi-line) editor Range into per-line column ranges. */
function collectRangeEmphasis(
  map: EmphasisRanges,
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  },
  lines: string[]
) {
  for (let ln = range.startLineNumber; ln <= range.endLineNumber; ln++) {
    const idx = ln - 1;
    if (idx < 0 || idx >= lines.length) continue;
    const start = ln === range.startLineNumber ? range.startColumn : 1;
    const end =
      ln === range.endLineNumber ? range.endColumn : lines[idx].length + 1;
    if (end <= start) continue;
    const existing = map.get(idx);
    if (existing) {
      existing.push([start, end]);
    } else {
      map.set(idx, [[start, end]]);
    }
  }
}

/** Turn a line plus its emphasis column ranges into render segments. */
function buildSegments(
  content: string,
  ranges: Array<[number, number]> | undefined,
  emphType: "insert" | "delete"
): RawLineSegment[] {
  if (!ranges || ranges.length === 0) {
    return [{ value: content, type: "normal" }];
  }

  // Sort and merge overlapping/adjacent ranges
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }

  // If the emphasis covers the whole line, skip it - the row background
  // already communicates the change (matches VS Code/GitHub).
  if (
    content.length > 0 &&
    merged.length === 1 &&
    merged[0][0] <= 1 &&
    merged[0][1] >= content.length + 1
  ) {
    return [{ value: content, type: "normal" }];
  }

  const segments: RawLineSegment[] = [];
  let pos = 1;
  for (const [rawStart, rawEnd] of merged) {
    const start = Math.max(pos, Math.min(rawStart, content.length + 1));
    const end = Math.max(start, Math.min(rawEnd, content.length + 1));
    if (start > pos) {
      segments.push({
        value: content.slice(pos - 1, start - 1),
        type: "normal",
      });
    }
    if (end > start) {
      segments.push({
        value: content.slice(start - 1, end - 1),
        type: emphType,
      });
    }
    pos = end;
  }
  if (pos <= content.length) {
    segments.push({ value: content.slice(pos - 1), type: "normal" });
  }
  return segments.filter((seg) => seg.value.length > 0);
}

/**
 * Build a hunk's display lines. The hunk's old side (context + deletes) is
 * re-diffed against its new side (context + inserts) with VS Code's diff
 * computer, ignoring leading/trailing whitespace. Lines that only changed
 * indentation (e.g. code wrapped in a new `if`) become context lines, like
 * GitHub's "hide whitespace" view, and the remaining changes get
 * character-level emphasis.
 */
export function computeHunkLines(changes: _Change[]): Line[] {
  const dels: Array<DeleteChange | NormalChange> = [];
  const adds: Array<InsertChange | NormalChange> = [];
  for (const c of changes) {
    if (c.type !== "insert") dels.push(c);
    if (c.type !== "delete") adds.push(c);
  }
  if (dels.length === adds.length && dels.length === changes.length) {
    return changes.map(changeToLine);
  }

  const delLines = dels.map((d) => d.content);
  const addLines = adds.map((a) => a.content);

  let diff: LinesDiff["changes"];
  try {
    diff = linesDiffComputer.computeDiff(delLines, addLines, {
      ignoreTrimWhitespace: true,
      computeMoves: false,
      maxComputationTimeMs: 500,
    }).changes;
  } catch {
    return changes.map(changeToLine);
  }

  const oldEmphasis: EmphasisRanges = new Map();
  const newEmphasis: EmphasisRanges = new Map();
  for (const change of diff) {
    if (!change.innerChanges) continue;
    for (const inner of change.innerChanges) {
      collectRangeEmphasis(oldEmphasis, inner.originalRange, delLines);
      collectRangeEmphasis(newEmphasis, inner.modifiedRange, addLines);
    }
  }

  const oldNumber = (c: DeleteChange | NormalChange) =>
    c.type === "normal" ? c.oldLineNumber : c.lineNumber;
  const newNumber = (c: InsertChange | NormalChange) =>
    c.type === "normal" ? c.newLineNumber : c.lineNumber;

  // 0-based cursors; unchanged runs between changes have equal length
  const out: Line[] = [];
  let di = 0;
  let ai = 0;
  const emitUnchanged = (delEnd: number) => {
    for (; di < delEnd; di++, ai++) {
      out.push({
        type: "normal",
        isNormal: true,
        oldLineNumber: oldNumber(dels[di]),
        newLineNumber: newNumber(adds[ai]),
        content: [{ value: addLines[ai], type: "normal" }],
      });
    }
  };

  for (const change of diff) {
    emitUnchanged(change.original.startLineNumber - 1);
    for (; di < change.original.endLineNumberExclusive - 1; di++) {
      out.push({
        type: "delete",
        isDelete: true,
        lineNumber: oldNumber(dels[di]),
        content: buildSegments(delLines[di], oldEmphasis.get(di), "delete"),
      });
    }
    for (; ai < change.modified.endLineNumberExclusive - 1; ai++) {
      out.push({
        type: "insert",
        isInsert: true,
        lineNumber: newNumber(adds[ai]),
        content: buildSegments(addLines[ai], newEmphasis.get(ai), "insert"),
      });
    }
  }
  emitUnchanged(dels.length);
  return out;
}
