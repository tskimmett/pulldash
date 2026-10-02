import { test, expect } from "bun:test";
import { folderPathsUnder } from "./folder-paths";

test("folder-paths: includes the folder and all nested folders but not siblings or files", () => {
  const files = ["a/b/c/x.ts", "a/b/y.ts", "a/z.ts", "a/bb/w.ts", "other/q.ts"];
  expect(folderPathsUnder("a/b", files).sort()).toEqual(["a/b", "a/b/c"]);
  expect(folderPathsUnder("a", files).sort()).toEqual([
    "a",
    "a/b",
    "a/b/c",
    "a/bb",
  ]);
});
