import { expect, test } from "bun:test";
import { parseDiffWithHighlighting, type DiffHunk } from "./diff-worker";

test("ignores file content that does not match the patch", () => {
  const patch = "@@ -2,2 +2,1 @@\n-removed();\n kept();";
  // Old content fetched at a ref where line 2 is something else
  const oldContent = "// header\nreturn filter.Invoke(instance);\nkept();\n";
  const newContent = "// header\nkept();\n";

  const diff = parseDiffWithHighlighting(
    patch,
    "file.ts",
    undefined,
    oldContent,
    newContent
  );
  const hunk = diff.hunks.find((h): h is DiffHunk => h.type === "hunk")!;
  const text = hunk.lines.map((line) =>
    line.content.map((seg) => seg.html.replace(/<[^>]+>/g, "")).join("")
  );

  expect(text).toEqual(["removed();", "kept();"]);
});
