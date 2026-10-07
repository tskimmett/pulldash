import { test, expect } from "bun:test";
import { unseenEntries, type ChangelogEntry } from "./changelog";

const entries: ChangelogEntry[] = [
  { id: "c", date: "3", title: "C" },
  { id: "b", date: "2", title: "B" },
  { id: "a", date: "1", title: "A" },
];

test("unseenEntries returns entries newer than the last seen id", () => {
  expect(unseenEntries(entries, null).map((e) => e.id)).toEqual([
    "c",
    "b",
    "a",
  ]);
  expect(unseenEntries(entries, "a").map((e) => e.id)).toEqual(["c", "b"]);
  expect(unseenEntries(entries, "c")).toEqual([]);
  expect(unseenEntries(entries, "gone")).toEqual(entries);
});
