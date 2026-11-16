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

test("highlights Vue SFC markup and TypeScript script blocks", () => {
  const content =
    '<template>\n  <div class="a">{{ msg }}</div>\n</template>\n<script lang="ts">\nconst x: number = 1;\n</script>\n';
  const patch =
    "@@ -0,0 +1,6 @@\n" +
    content
      .trimEnd()
      .split("\n")
      .map((l) => `+${l}`)
      .join("\n");

  const diff = parseDiffWithHighlighting(
    patch,
    "Comp.vue",
    undefined,
    "",
    content
  );
  const hunk = diff.hunks.find((h): h is DiffHunk => h.type === "hunk")!;
  const html = hunk.lines.map((line) =>
    line.content.map((seg) => seg.html).join("")
  );

  expect(html[0]).toContain('class="token tag"');
  expect(html[4]).toContain('class="token keyword"');
  expect(html[4]).toContain('class="token builtin">number');
});
