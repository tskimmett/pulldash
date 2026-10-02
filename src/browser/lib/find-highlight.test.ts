import { expect, test } from "bun:test";
import { findOccurrences } from "./find-highlight";

test("findOccurrences finds every case-insensitive, non-overlapping match", () => {
  expect(findOccurrences("Foo foo FOO", "foo")).toEqual([0, 4, 8]);
  expect(findOccurrences("aaaa", "aa")).toEqual([0, 2]);
  expect(findOccurrences("abc", "")).toEqual([]);
});
