import { expect, test } from "bun:test";
import { commentContextLines } from "./comment-context";
import type { DiffLine } from "./diff-worker";

const insert = (n: number): DiffLine => ({
  type: "insert",
  lineNumber: n,
  newLineNumber: n,
  content: [],
});
const del = (n: number): DiffLine => ({
  type: "delete",
  lineNumber: n,
  oldLineNumber: n,
  content: [],
});
const numbers = (lines: DiffLine[]) =>
  lines.map((l) => (l.type === "delete" ? -l.oldLineNumber! : l.newLineNumber));

test("keeps the commented line plus four lines of context from a long hunk", () => {
  const newFile = Array.from({ length: 856 }, (_, i) => insert(i + 1));
  expect(numbers(commentContextLines(newFile, null))).toEqual([
    852, 853, 854, 855, 856,
  ]);
});

test("extends to the start of a multi-line comment", () => {
  const newFile = Array.from({ length: 829 }, (_, i) => insert(i + 1));
  expect(numbers(commentContextLines(newFile, 826))).toEqual([
    822, 823, 824, 825, 826, 827, 828, 829,
  ]);
});

test("matches the start line on the old side for comments on deletions", () => {
  const lines = [insert(1), del(1), del(2), del(3), del(4), del(5), del(6)];
  expect(numbers(commentContextLines(lines, 5))).toEqual([
    -1, -2, -3, -4, -5, -6,
  ]);
  expect(numbers(commentContextLines(lines, 6))).toEqual([-2, -3, -4, -5, -6]);
});
