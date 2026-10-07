import { expect, test } from "bun:test";
import gitDiffParser from "gitdiff-parser";
import { computeHunkLines } from "./hunk-lines";

function hunkLines(patch: string) {
  const [file] = gitDiffParser.parse(
    `diff --git a/x.cs b/x.cs\n--- a/x.cs\n+++ b/x.cs\n${patch}`
  );
  return computeHunkLines(file.hunks[0].changes).map((l) => {
    const text = l.content.map((s) => s.value).join("");
    if (l.type === "normal") {
      return `  ${l.oldLineNumber},${l.newLineNumber} ${text}`;
    }
    return `${l.type === "insert" ? "+" : "-"} ${l.lineNumber} ${text}`;
  });
}

test("re-indented lines render as context, like GitHub's hide-whitespace view", () => {
  // `try { ... }` wrapped in `if (ok) { ... }`. Git anchored on the `{`
  // line at mismatched indentation, splitting the re-indented body.
  const patch = [
    "@@ -1,8 +1,11 @@",
    " var x = 1;",
    "-try",
    "+if (ok)",
    " {",
    "-  run();",
    "-  {",
    "-    done();",
    "-  }",
    "+  try",
    "+  {",
    "+    run();",
    "+    {",
    "+      done();",
    "+    }",
    "+  }",
    " }",
  ].join("\n");

  expect(hunkLines(patch)).toEqual([
    "  1,1 var x = 1;",
    "+ 2 if (ok)",
    "+ 3 {",
    "  2,4   try",
    "  3,5   {",
    "  4,6     run();",
    "  5,7     {",
    "  6,8       done();",
    "+ 9     }",
    "  7,10   }",
    "  8,11 }",
  ]);
});
