import { expect, test } from "bun:test";
import { parsePatchLines } from "./patch-lines";

test("parsePatchLines keeps line numbers across hunks and ignores metadata", () => {
  expect(
    parsePatchLines(
      "@@ -2,2 +2,3 @@ heading\n same\n-old\n+new\n+extra\n\\ No newline at end of file\n@@ -10 +11 @@\n tail"
    )
  ).toEqual([
    { type: "hunk", content: "@@ -2,2 +2,3 @@ heading" },
    { type: "normal", content: "same", oldLine: 2, newLine: 2 },
    { type: "delete", content: "old", oldLine: 3 },
    { type: "insert", content: "new", newLine: 3 },
    { type: "insert", content: "extra", newLine: 4 },
    { type: "hunk", content: "@@ -10 +11 @@" },
    { type: "normal", content: "tail", oldLine: 10, newLine: 11 },
  ]);
});
