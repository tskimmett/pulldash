import { expect, test } from "bun:test";
import { gapLineOffsets } from "./gap-offsets";

const hunk = (oldStart: number, newStart: number, types: string[]) => ({
  type: "hunk" as const,
  oldStart,
  newStart,
  lines: types.map((type) => ({ type })),
});

test("tracks line drift across hunks, including whole-side hunks", () => {
  expect(
    gapLineOffsets([
      { type: "skip" },
      // 1 line replaced by 3
      hunk(10, 10, ["normal", "delete", "insert", "insert", "insert"]),
      { type: "skip" },
      // 2 lines removed
      hunk(50, 52, ["normal", "delete", "delete", "normal"]),
      { type: "skip" },
    ])
  ).toEqual([0, 2, 0, 0]);
  // Added file: no old lines, nothing after it
  expect(gapLineOffsets([hunk(0, 1, ["insert", "insert"])])).toEqual([2]);
});
